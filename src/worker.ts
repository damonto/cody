import { Hono } from "hono";
import { gatewayRoutes } from "./gateway/app.ts";
import { gatewayNotFound } from "./gateway/handler.ts";
import { adminApp } from "./admin/app.ts";
import { CONSOLE_PATH } from "./admin/paths.ts";
import { DEFAULT_REPORTING } from "./billing/config.ts";
import { ControlStore } from "./control/store.ts";
import { cleanupRequests, ingestUsage } from "./reporting/store.ts";
import { parseUsageEvent } from "./telemetry/schema.ts";

export { ProviderHealth } from "./gateway/health/provider-health.ts";
export { SessionAffinity } from "./gateway/sessions/session-affinity.ts";
export { SessionAffinityIndex } from "./gateway/sessions/session-affinity-index.ts";
export { ResponsesWebSocketProxy } from "./gateway/websocket/responses-websocket-proxy.ts";
export { UsageOutbox } from "./telemetry/outbox.ts";
export { ConfigPublisher } from "./control/publisher.ts";

export const app = new Hono<{ Bindings: Env }>()
  .route("/", gatewayRoutes)
  .get("/", (c) =>
    c.redirect(`${CONSOLE_PATH}/${new URL(c.req.url).search}`, 302),
  )
  .get(CONSOLE_PATH, (c) =>
    c.redirect(`${CONSOLE_PATH}/${new URL(c.req.url).search}`, 308),
  )
  .route(CONSOLE_PATH, adminApp)
  .all("*", gatewayNotFound);

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
    const store = new ControlStore(
      env.CODY_DB,
      env.CODY_CONFIG_KV,
      env.CONFIG_ENCRYPTION_KEY,
      env.CONFIG_KEY,
    );
    const state = await store.state();
    const config = state.published_revision
      ? await store.revision(state.published_revision)
      : null;
    await cleanupRequests(
      env.CODY_DB,
      config?.reporting?.retention_days ?? DEFAULT_REPORTING.retention_days,
    );
  },
} satisfies ExportedHandler<Env>;
