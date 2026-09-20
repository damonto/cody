import { DurableObject } from "cloudflare:workers";
import { ingestUsage } from "../reporting/store.ts";
import { logWarn } from "../shared/log.ts";
import { parseUsageEvent } from "./schema.ts";
import type { UsageEvent } from "./types.ts";

const PREFIX = "event:";
const CURSOR_KEY = "delivery-cursor";
const RETRY_DELAY_MS = 10_000;
const BATCH_SIZE = 25;
const MAX_BATCHES = 4;
// Cloudflare caps batches at 256 KB, including message metadata. Leave room
// for metadata and count UTF-8 bytes rather than JavaScript string length.
const MAX_QUEUE_BATCH_BYTES = 240_000;

interface JournalEntry {
  readonly key: string;
  readonly event: UsageEvent;
}

function queueBatches(entries: readonly JournalEntry[]): JournalEntry[][] {
  const batches: JournalEntry[][] = [];
  const encoder = new TextEncoder();
  let batch: JournalEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(entry.event)).byteLength;
    if (batch.length > 0 && bytes + size > MAX_QUEUE_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/** A durable usage journal; only terminal records are published to the Queue. */
export class UsageOutbox extends DurableObject<Env> {
  private flushing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialization is owned by the Durable Object runtime.
    void this.ctx.blockConcurrencyWhile(() => this.schedule());
  }

  async enqueue(input: unknown): Promise<void> {
    const event = parseUsageEvent(input);
    if (event === null) {
      return;
    }
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
        await transaction.delete(CURSOR_KEY);
        await transaction.deleteAlarm();
      }
    });
  }

  private flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    const task = this.deliver();
    this.flushing = task.finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    try {
      let cursor = await this.ctx.storage.get<string>(CURSOR_KEY);
      for (let pass = 0; pass < MAX_BATCHES; pass++) {
        let pending = await this.ctx.storage.list<unknown>({
          prefix: PREFIX,
          limit: BATCH_SIZE,
          ...(cursor === undefined ? {} : { startAfter: cursor }),
        });
        if (pending.size === 0 && cursor !== undefined) {
          await this.ctx.storage.delete(CURSOR_KEY);
          if (pass > 0) {
            break;
          }
          pending = await this.ctx.storage.list<unknown>({
            prefix: PREFIX,
            limit: BATCH_SIZE,
          });
        }
        const last = [...pending.keys()].at(-1);
        if (last === undefined) {
          break;
        }
        const entries: JournalEntry[] = [];
        for (const [key, value] of pending) {
          try {
            const event = parseUsageEvent(value);
            if (event === null) {
              await this.ctx.storage.delete(key);
            } else {
              entries.push({ key, event });
            }
          } catch {
            // Retain bad records for inspection without starving later deliveries.
            logWarn("usage.outbox.invalid_record", { key });
          }
        }
        await this.deliverEntries(entries);
        cursor = last;
        // Resume beyond failures on the next alarm, including after eviction.
        await this.ctx.storage.put(CURSOR_KEY, cursor);
      }
    } catch {
      logWarn("usage.outbox.delivery_failed", {});
    } finally {
      await this.schedule();
    }
  }

  private async deliverEntries(
    entries: readonly JournalEntry[],
  ): Promise<void> {
    // Each destination acknowledges its own successful writes. D1 failure
    // must not prevent terminal records from reaching the Queue, or vice versa.
    await Promise.all([
      this.deliverProgress(
        entries.filter((entry) => entry.event.phase !== "finished"),
      ),
      this.deliverFinished(
        entries.filter((entry) => entry.event.phase === "finished"),
      ),
    ]);
  }

  private async deliverProgress(
    entries: readonly JournalEntry[],
  ): Promise<void> {
    for (const { key, event } of entries) {
      try {
        await ingestUsage(this.env.CODY_DB, event);
        await this.ctx.storage.delete(key);
      } catch {
        logWarn("usage.outbox.progress_failed", {
          request_id: event.request_id,
          sequence: event.sequence,
        });
      }
    }
  }

  private async deliverFinished(
    entries: readonly JournalEntry[],
  ): Promise<void> {
    for (const batch of queueBatches(entries)) {
      try {
        await this.env.USAGE_QUEUE.sendBatch(
          batch.map(({ event }) => ({ body: event, contentType: "json" })),
        );
        await this.ctx.storage.delete(batch.map((entry) => entry.key));
      } catch {
        logWarn("usage.outbox.queue_failed", {
          request_ids: batch.map((entry) => entry.event.request_id),
        });
      }
    }
  }

  override async alarm(): Promise<void> {
    await this.flush();
  }
}
