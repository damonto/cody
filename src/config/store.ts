import type { RequestLogContext } from "../shared/log.ts";
import { ConfigError } from "./parse.ts";
import type { GatewayConfig } from "./types.ts";
import type { Bindings, SqlDatabase } from "../platform/bindings.ts";
import { ControlStore } from "../control/store.ts";

export { ConfigError, parseConfig } from "./parse.ts";
interface CachedConfig {
  version: number;
  key: string;
  config: GatewayConfig;
}
let stores = new WeakMap<SqlDatabase, CachedConfig>();

/** Read the primary SQL version for every request. Cache only immutable snapshots. */
export async function loadConfig(
  env: Bindings,
  requestLog?: RequestLogContext,
): Promise<GatewayConfig> {
  try {
    const store = new ControlStore(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY);
    const state = await store.state();
    if (state.maintenance)
      throw new ConfigError("Configuration is in maintenance mode");
    if (!state.version)
      throw new ConfigError(
        "Configuration is not initialized; create configuration resources in the console",
      );
    const cached = stores.get(env.CODY_DB);
    if (
      cached?.version === state.version &&
      cached.key === env.CONFIG_ENCRYPTION_KEY
    ) {
      requestLog?.mergeSection("configuration", {
        source: "cache",
        version: state.version,
      });
      return cached.config;
    }
    const config = await store.revision(state.version);
    stores.set(env.CODY_DB, {
      version: state.version,
      key: env.CONFIG_ENCRYPTION_KEY,
      config,
    });
    requestLog?.mergeSection("configuration", {
      source: "sql",
      version: state.version,
    });
    return config;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Configuration could not be loaded from SQL");
  }
}
export function clearConfigCacheForTests(): void {
  stores = new WeakMap();
}
