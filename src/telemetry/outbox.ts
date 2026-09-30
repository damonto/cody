import { UsagePhase } from "./values.ts";

import { ingestUsage } from "../reporting/store.ts";
import { logWarn } from "../shared/log.ts";
import { parseUsageEvent } from "./schema.ts";
import {
  MAX_RETRY_DELAY_MS,
  RETRY_DELAY_MS,
  nextDeliveryRetry,
  parseDeliveryRetry,
  type DeliveryRetry,
} from "./delivery-backoff.ts";
import type { UsageEvent } from "./types.ts";
import type { Bindings } from "../platform/bindings.ts";
import type { ObjectContext } from "../platform/object-context.ts";

const PREFIX = "event:";
const CURSOR_KEY = "delivery-cursor";
const RETRY_PREFIX = "delivery-retry:";
const BATCH_SIZE = 25;
const MAX_BATCHES = 4;
// Cloudflare caps batches at 256 KB, including message metadata. Leave room
// for metadata and count UTF-8 bytes rather than JavaScript string length.
const MAX_QUEUE_BATCH_BYTES = 240_000;

interface JournalEntry {
  readonly key: string;
  readonly event: UsageEvent;
}

type Destination = "d1" | "queue";

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
export class UsageOutboxCore {
  private flushing: Promise<void> | undefined;
  private enqueuedDuringFlush = false;
  private retries: Record<Destination, DeliveryRetry | undefined> = {
    d1: undefined,
    queue: undefined,
  };

  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: Bindings,
  ) {
    // Initialization is owned by the Durable Object runtime.
    void this.ctx.blockConcurrencyWhile(() => this.schedule());
  }

  async enqueue(input: unknown): Promise<void> {
    const event = parseUsageEvent(input);
    if (event === null) {
      return;
    }
    const key = `${PREFIX}${event.request_id}:${event.sequence}`;
    const ready = await this.ctx.storage.transaction(async (transaction) => {
      // An RPC retry may repeat an accepted event. Keep its original payload.
      if ((await transaction.get(key)) === undefined) {
        await transaction.put(key, event);
      }
      const retry = parseDeliveryRetry(
        await transaction.get(RETRY_PREFIX + this.destination(event)),
      );
      const now = Date.now();
      const ready = !retry || retry.until <= now;
      const wakeAt = ready ? now + RETRY_DELAY_MS : retry.until;
      const alarm = await transaction.getAlarm();
      if (alarm === null || wakeAt < alarm) {
        await transaction.setAlarm(wakeAt);
      }
      return ready;
    });
    // New records remain durable without bypassing a destination's backoff.
    if (ready) {
      if (this.flushing) this.enqueuedDuringFlush = true;
      this.ctx.waitUntil(this.flush());
    }
  }

  private destination(event: UsageEvent): Destination {
    return event.phase === UsagePhase.Finished ? "queue" : "d1";
  }

  private ready(destination: Destination): boolean {
    return (this.retries[destination]?.until ?? 0) <= Date.now();
  }

  private async failed(
    destination: Destination,
    error: unknown,
  ): Promise<void> {
    const retry = nextDeliveryRetry(this.retries[destination], error);
    await this.ctx.storage.put(RETRY_PREFIX + destination, retry);
    this.retries[destination] = retry;
  }

  private async acknowledge(
    destination: Destination,
    keys: string[],
  ): Promise<void> {
    // A local acknowledgement failure must retain both the journal entries and
    // retry state. Re-delivery is safe because usage ingestion is idempotent.
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete([...keys, RETRY_PREFIX + destination]);
    });
    this.retries[destination] = undefined;
  }

  private schedule(nextAt?: number): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const pending = await transaction.list({ prefix: PREFIX, limit: 1 });
      if (pending.size) {
        const alarm = await transaction.getAlarm();
        if (nextAt !== undefined) {
          // Retire obsolete recovery alarms after a completed scan, but wake
          // promptly for eligible enqueues that may have missed its cursor.
          await transaction.setAlarm(
            this.enqueuedDuringFlush
              ? Math.min(nextAt, Date.now() + RETRY_DELAY_MS)
              : nextAt,
          );
        } else if (alarm === null || alarm <= Date.now()) {
          await transaction.setAlarm(Date.now() + RETRY_DELAY_MS);
        }
      } else {
        await transaction.delete(CURSOR_KEY);
        await transaction.delete([RETRY_PREFIX + "d1", RETRY_PREFIX + "queue"]);
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
    this.enqueuedDuringFlush = false;
    let nextAt = Date.now() + RETRY_DELAY_MS;
    try {
      const retries = await this.ctx.storage.get([
        RETRY_PREFIX + "d1",
        RETRY_PREFIX + "queue",
      ]);
      this.retries = {
        d1: parseDeliveryRetry(retries.get(RETRY_PREFIX + "d1")),
        queue: parseDeliveryRetry(retries.get(RETRY_PREFIX + "queue")),
      };
      let cursor = await this.ctx.storage.get<string>(CURSOR_KEY);
      let invalid = false;
      const deferred = new Set<Destination>();
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
            invalid = true;
            logWarn("usage.outbox.invalid_record", { key });
          }
        }
        for (const destination of await this.deliverEntries(entries)) {
          deferred.add(destination);
        }
        cursor = last;
        // Resume beyond failures on the next alarm, including after eviction.
        await this.ctx.storage.put(CURSOR_KEY, cursor);
      }
      const remaining = await this.ctx.storage.list({
        prefix: PREFIX,
        limit: 1,
        ...(cursor === undefined ? {} : { startAfter: cursor }),
      });
      // Finish scanning a bounded backlog promptly so one destination cannot
      // hide the other's records behind its failures. Once scanned, sleep until
      // a retry is due; new eligible records still trigger an immediate flush.
      const deadlines = Object.values(this.retries).flatMap((retry) =>
        retry
          ? [
              retry.until > Date.now()
                ? retry.until
                : Date.now() + RETRY_DELAY_MS,
            ]
          : [],
      );
      // A retry may expire midway through a scan. Later records succeeding do
      // not acknowledge earlier skipped records of that same destination.
      for (const destination of deferred) {
        if (this.ready(destination))
          deadlines.push(Date.now() + RETRY_DELAY_MS);
      }
      if (invalid) deadlines.push(Date.now() + MAX_RETRY_DELAY_MS);
      if (remaining.size === 0 && deadlines.length)
        nextAt = Math.min(...deadlines);
    } catch {
      logWarn("usage.outbox.delivery_failed", {});
    } finally {
      await this.schedule(nextAt);
    }
  }

  private async deliverEntries(
    entries: readonly JournalEntry[],
  ): Promise<Destination[]> {
    // Each destination acknowledges its own successful writes. D1 failure
    // must not prevent terminal records from reaching the Queue, or vice versa.
    const results = await Promise.allSettled([
      this.deliverProgress(
        entries.filter((entry) => entry.event.phase !== UsagePhase.Finished),
      ),
      this.deliverFinished(
        entries.filter((entry) => entry.event.phase === UsagePhase.Finished),
      ),
    ]);
    // Keep the flush single-flight until both destinations have settled, even
    // when a local acknowledgement or retry-state write fails.
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const deferred: Destination[] = [];
    if (results[0].status === "fulfilled" && !results[0].value)
      deferred.push("d1");
    if (results[1].status === "fulfilled" && !results[1].value)
      deferred.push("queue");
    return deferred;
  }

  private async deliverProgress(
    entries: readonly JournalEntry[],
  ): Promise<boolean> {
    for (const { key, event } of entries) {
      if (!this.ready("d1")) return false;
      try {
        await ingestUsage(this.env.CODY_DB, event);
      } catch (error) {
        await this.failed("d1", error);
        logWarn("usage.outbox.progress_failed", {
          request_id: event.request_id,
          sequence: event.sequence,
        });
        return false;
      }
      await this.acknowledge("d1", [key]);
    }
    return true;
  }

  private async deliverFinished(
    entries: readonly JournalEntry[],
  ): Promise<boolean> {
    for (const batch of queueBatches(entries)) {
      if (!this.ready("queue")) return false;
      try {
        await this.env.USAGE_QUEUE.sendBatch(
          batch.map(({ event }) => ({ body: event, contentType: "json" })),
        );
      } catch (error) {
        await this.failed("queue", error);
        logWarn("usage.outbox.queue_failed", {
          request_ids: batch.map((entry) => entry.event.request_id),
        });
        return false;
      }
      await this.acknowledge(
        "queue",
        batch.map((entry) => entry.key),
      );
    }
    return true;
  }

  async alarm(): Promise<void> {
    await this.flush();
  }
}
