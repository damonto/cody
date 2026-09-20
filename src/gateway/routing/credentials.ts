import type { GatewayConfig } from "../../config/types.ts";
import { credentialSecretValues } from "../../providers/credentials.ts";

const MAX_SECRET_CACHE_ENTRIES = 16;
const upstreamSecretsByRevision = new Map<number, readonly string[]>();
const upstreamSecretsByConfig = new WeakMap<GatewayConfig, readonly string[]>();

export function upstreamSecretValues(config: GatewayConfig): readonly string[] {
  // Revision-keyed caching survives loadConfig() re-parses after TTL expiry.
  if (config.revision) {
    const revisionCached = upstreamSecretsByRevision.get(config.revision);
    if (revisionCached) {
      upstreamSecretsByConfig.set(config, revisionCached);
      return revisionCached;
    }
  }
  const cached = upstreamSecretsByConfig.get(config);
  if (cached) {
    return cached;
  }
  const values = config.providers.flatMap((provider) =>
    provider.credentials.flatMap(credentialSecretValues),
  );
  values.push(
    ...(config.proxy_groups ?? []).flatMap((group) =>
      group.proxies.flatMap((proxy) =>
        proxy.password ? [proxy.password] : [],
      ),
    ),
  );
  const allValues =
    config.web_search.mode === "proxy"
      ? values
      : [...values, config.web_search.api_key];
  upstreamSecretsByConfig.set(config, allValues);
  if (config.revision) {
    upstreamSecretsByRevision.set(config.revision, allValues);
    // Bound memory if revisions change frequently.
    if (upstreamSecretsByRevision.size > MAX_SECRET_CACHE_ENTRIES) {
      const oldest = upstreamSecretsByRevision.keys().next().value;
      if (oldest !== undefined) upstreamSecretsByRevision.delete(oldest);
    }
  }
  return allValues;
}
