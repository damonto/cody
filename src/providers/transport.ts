import { ProviderType } from "../config/values.ts";
import type { UpstreamTransportPolicy } from "../gateway/transport/index.ts";
import type { Bindings } from "../platform/bindings.ts";

/** Shared by inference and account operations so both use the provider's transport policy. */
export function providerTransportPolicy(
  type: ProviderType,
  env?: Pick<Bindings, "UPSTREAM_HTTP">,
): UpstreamTransportPolicy {
  // Antigravity uses HTTP/1.1 without ALPN; Worker direct requests retain native fetch.
  return type === ProviderType.Antigravity
    ? { direct: env?.UPSTREAM_HTTP?.antigravity, socks: { omitAlpn: true } }
    : {};
}
