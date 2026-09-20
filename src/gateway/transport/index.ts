import type {
  ProviderConfig,
  ProviderCredentialConfig,
} from "../../config/types.ts";
import {
  createProxyTransport,
  type ProxyTransportContext,
} from "../proxies/transport.ts";
import { effectiveProxyGroup } from "../proxies/configuration.ts";
import type { ProxyFailure } from "../proxies/errors.ts";
export { socksFetch, type SocksFetchOptions } from "./socks-fetch.ts";
export { effectiveProxyGroup } from "../proxies/configuration.ts";

export type UpstreamFetch = (request: Request) => Promise<Response>;
export interface UpstreamTransport {
  readonly send: UpstreamFetch;
  readonly proxyFailure: (error: unknown) => ProxyFailure | undefined;
}

export function createUpstreamTransport(
  provider: Pick<ProviderConfig, "id" | "proxy_group">,
  credential: Pick<ProviderCredentialConfig, "id" | "proxy_group">,
  context?: ProxyTransportContext,
): UpstreamTransport {
  const selection = effectiveProxyGroup(provider, credential);
  return selection
    ? createProxyTransport(selection, context)
    : {
        send: (request) => fetch(request),
        proxyFailure: () => undefined,
      };
}

export function createUpstreamFetch(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
  context?: ProxyTransportContext,
): UpstreamFetch {
  return createUpstreamTransport(provider, credential, context).send;
}
