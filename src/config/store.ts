import { errorMessage, type RequestLogContext } from "../shared/log.ts";
import { configurationError, configurationSchema } from "./schema.ts";
import type { GatewayConfig } from "./types.ts";
import type { Bindings, KeyValueStore } from "../platform/bindings.ts";
const DEFAULT_CONFIG_KEY = "gateway-config";
const DEFAULT_CACHE_TTL_SECONDS = 10;
export class ConfigError extends Error {
  override name = "ConfigError";
}
interface CachedConfig {
  config: GatewayConfig;
  expiresAt: number;
}
// A process may host multiple application instances with distinct stores.
let stores = new WeakMap<KeyValueStore, Map<string, CachedConfig>>();
export function parseConfig(value: unknown): GatewayConfig {
  const result = configurationSchema.safeParse(value);
  if (!result.success) throw new ConfigError(configurationError(result.error));
  return result.data;
}
function cacheTtlMs(env: Bindings): number {
  const configured = Number(
    env.CONFIG_CACHE_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS,
  );
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_CACHE_TTL_SECONDS * 1000;
  }
  return Math.min(configured, 300) * 1000;
}

export async function loadConfig(
  env: Bindings,
  requestLog?: RequestLogContext,
): Promise<GatewayConfig> {
  const now = Date.now();
  const key = env.CONFIG_KEY ?? DEFAULT_CONFIG_KEY;
  let snapshots = stores.get(env.CODY_CONFIG_KV);
  if (!snapshots) {
    snapshots = new Map();
    stores.set(env.CODY_CONFIG_KV, snapshots);
  }
  let cached = snapshots.get(key);
  if (cached && cached.expiresAt > now) {
    requestLog?.mergeSection("configuration", { source: "cache" });
    return cached.config;
  }

  try {
    const raw = await env.CODY_CONFIG_KV.get(key);
    if (!raw) {
      throw new ConfigError("configuration key is missing from CODY_CONFIG_KV");
    }
    const config = parseConfig(JSON.parse(raw) as unknown);
    const ttlMs = cacheTtlMs(env);
    cached = { config, expiresAt: now + ttlMs };
    snapshots.set(key, cached);
    requestLog?.mergeSection("configuration", {
      source: "kv",
      cache_ttl_ms: ttlMs,
    });
    return config;
  } catch (error) {
    if (cached) {
      cached.expiresAt = now + 5000;
      requestLog?.warn({
        configuration: {
          source: "stale_cache",
          error: errorMessage(error),
        },
      });
      return cached.config;
    }
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(
      `configuration could not be loaded: ${String(error)}`,
    );
  }
}

export function clearConfigCacheForTests(): void {
  stores = new WeakMap();
}
