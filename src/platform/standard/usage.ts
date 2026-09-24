import { ingestUsage } from "../../reporting/store.ts";
import { parseUsageEvent } from "../../telemetry/schema.ts";
import type { QueueMessage, SqlDatabase, UsageQueue } from "../bindings.ts";

async function ingest(db: SqlDatabase, body: unknown): Promise<void> {
  const event = parseUsageEvent(body);
  if (event !== null) await ingestUsage(db, event);
}

/** Terminal WebSocket usage events, written straight into SQL. */
export class DirectIngestQueue implements UsageQueue {
  constructor(private readonly db: SqlDatabase) {}

  send(body: unknown): Promise<void> {
    return ingest(this.db, body);
  }

  async sendBatch(messages: Iterable<QueueMessage>): Promise<void> {
    for (const message of messages) await ingest(this.db, message.body);
  }
}
