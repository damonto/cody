import { DEFAULT_REPORTING } from "./billing/config.ts";
import { ControlStore } from "./control/store.ts";
import type { Bindings } from "./platform/bindings.ts";
import { cleanupRequests, expirePendingRequests } from "./reporting/store.ts";
import { refreshAntigravityVersion } from "./providers/antigravity/version.ts";

/** Hourly reporting upkeep shared by the Worker cron and standard runtimes. */
export async function runMaintenance(
  env: Pick<Bindings, "CODY_DB" | "CODY_CONFIG_KV" | "CONFIG_ENCRYPTION_KEY">,
): Promise<void> {
  const store = new ControlStore(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY);
  const state = await store.state();
  if (state.maintenance) return;
  const config = state.version ? await store.revision(state.version) : null;
  await expirePendingRequests(env.CODY_DB);
  await cleanupRequests(
    env.CODY_DB,
    config?.reporting?.retention_days ?? DEFAULT_REPORTING.retention_days,
  );
  if (
    config?.providers.some(
      (provider) => provider.type === "antigravity" && !provider.disabled,
    )
  )
    await refreshAntigravityVersion(env.CODY_CONFIG_KV);
}
