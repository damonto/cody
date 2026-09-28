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

let directWebSocket: UpstreamFetch | undefined;

/**
 * Standard runtimes cannot perform a WebSocket upgrade through `fetch`; they
 * install a WebSocket client for direct (non-proxied) upstream connections.
 */
export function setDirectWebSocketConnector(
  connector: UpstreamFetch | undefined,
): void {
  directWebSocket = connector;
}

function directFetch(request: Request): Promise<Response> {
  return directWebSocket &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ? directWebSocket(request)
    : fetch(request);
}
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
  const antigravity = provider.id === "antigravity";
  const directAntigravity = context?.env.UPSTREAM_HTTP?.antigravity;
  return selection
    ? createProxyTransport(
        selection,
        context && antigravity
          ? {
              ...context,
              socks: { ...context.socks, omitAlpn: true },
            }
          : context,
      )
    : {
        send:
          antigravity && directAntigravity ? directAntigravity : directFetch,
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
