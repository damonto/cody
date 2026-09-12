import { DurableObject } from "cloudflare:workers";
import type { UsageEvent } from "./types.ts";

const PREFIX = "event:";
const RETRY_DELAY_MS = 10_000;
const BATCH_SIZE = 25;
const MAX_BATCHES = 4;

/** A shard of the HTTP usage journal. Queue delivery never owns the only copy. */
export class UsageOutbox extends DurableObject<Env> {
  private flushing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialization is owned by the Durable Object runtime.
    void ctx.blockConcurrencyWhile(() => this.schedule());
  }

  async enqueue(event: UsageEvent): Promise<void> {
    const key = `${PREFIX}${event.request_id}:${event.sequence}`;
    await this.ctx.storage.transaction(async (transaction) => {
      // An RPC retry may repeat an accepted event. Keep its original payload.
      if ((await transaction.get(key)) === undefined) {
        await transaction.put(key, event);
      }
      if ((await transaction.getAlarm()) === null) {
        await transaction.setAlarm(Date.now() + RETRY_DELAY_MS);
      }
    });
    this.ctx.waitUntil(this.flush());
  }

  private schedule(): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const pending = await transaction.list({ prefix: PREFIX, limit: 1 });
      if (pending.size) {
        if ((await transaction.getAlarm()) === null) {
          await transaction.setAlarm(Date.now() + RETRY_DELAY_MS);
        }
      } else {
        await transaction.deleteAlarm();
      }
    });
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const task = this.deliver();
    this.flushing = task.finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    try {
      for (let pass = 0; pass < MAX_BATCHES; pass++) {
        const pending = await this.ctx.storage.list<UsageEvent>({
          prefix: PREFIX,
          limit: BATCH_SIZE,
        });
        if (!pending.size) break;
        await this.env.USAGE_QUEUE.sendBatch(
          [...pending.values()].map((body) => ({ body, contentType: "json" })),
        );
        await this.ctx.storage.delete([...pending.keys()]);
      }
    } catch {
      console.warn({ event: "usage.outbox.delivery_failed" });
    } finally {
      await this.schedule();
    }
  }

  override async alarm(): Promise<void> {
    await this.flush();
  }
}
