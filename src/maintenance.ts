import { DEFAULT_REPORTING } from "./billing/config.ts";
import { ControlStore } from "./control/store.ts";
import type { Bindings } from "./platform/bindings.ts";
import { cleanupRequests, expirePendingRequests } from "./reporting/store.ts";

/** Hourly reporting upkeep shared by the Worker cron and standard runtimes. */
export async function runMaintenance(
  env: Pick<
    Bindings,
    "CODY_DB" | "CODY_CONFIG_KV" | "CONFIG_ENCRYPTION_KEY" | "CONFIG_KEY"
  >,
): Promise<void> {
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
  await expirePendingRequests(env.CODY_DB);
  await cleanupRequests(
    env.CODY_DB,
    config?.reporting?.retention_days ?? DEFAULT_REPORTING.retention_days,
  );
}
