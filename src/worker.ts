import { app } from "./app.ts";
import { runMaintenance } from "./maintenance.ts";
import { ingestUsage } from "./reporting/store.ts";
import { parseUsageEvent } from "./telemetry/schema.ts";

export { app } from "./app.ts";
export { ProxyGroup } from "./gateway/proxies/proxy-group.ts";
export { SessionAffinityIndex } from "./gateway/sessions/session-affinity-index.ts";
export {
  ConfigPublisher,
  ProviderHealth,
  ProviderOAuthAccount,
  ResponsesWebSocketProxy,
  SessionAffinity,
  UsageOutbox,
} from "./platform/cloudflare/objects.ts";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = parseUsageEvent(message.body);
        if (event !== null) {
          await ingestUsage(env.CODY_DB, event);
        }
        message.ack();
      } catch {
        console.warn({
          event: "usage.ingest.failed",
          message_id: message.id,
          attempts: message.attempts,
        });
        message.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runMaintenance(env);
  },
} satisfies ExportedHandler<Env>;
