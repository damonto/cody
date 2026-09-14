import type {
  ProviderCredentialConfig,
  ProviderConfig,
  SocksProxyConfig,
} from "../../config/types.ts";
import { openSocksTunnel, type SocksDial } from "./socks.ts";
import { httpOverConnection } from "./http.ts";
import { websocketOverConnection } from "./websocket.ts";
import type { Connection } from "./bytes.ts";

export type UpstreamFetch = (request: Request) => Promise<Response>;
export interface SocksFetchOptions {
  readonly dial?: SocksDial;
  /** Extra trusted roots for local integration fixtures; never a configuration option. */
  readonly trustedCertificates?: readonly string[];
  readonly connectTimeoutMs?: number;
}

export function effectiveProxy(
  provider: Pick<ProviderConfig, "proxy">,
  key: Pick<ProviderCredentialConfig, "proxy">,
): SocksProxyConfig | undefined {
  return (key.proxy === undefined ? provider.proxy : key.proxy) ?? undefined;
}

export function createUpstreamFetch(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
): UpstreamFetch {
  const proxy = effectiveProxy(provider, credential);
  return proxy
    ? (request) => socksFetch(request, proxy)
    : (request) => fetch(request);
}

/** No pooling, implicit retries, direct fallback, or redirect following. */
export async function socksFetch(
  request: Request,
  proxy: SocksProxyConfig,
  options: SocksFetchOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("SOCKS5 transport requires an HTTP or HTTPS target");
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new RangeError(
      "SOCKS5 connection timeout must be positive and finite",
    );
  }
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error("SOCKS5 connection timed out")),
    connectTimeoutMs,
  );
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let connection: Connection | undefined;
  try {
    connection = await openSocksTunnel(
      proxy,
      {
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      },
      signal,
      options.dial,
    );
    if (url.protocol === "https:") {
      const { secureConnection } = await import("./tls.ts");
      connection = await secureConnection(
        connection,
        url.hostname,
        options.trustedCertificates,
      );
    }
    clearTimeout(timeout);
    signal.throwIfAborted();
    const outgoing = new Request(request, { signal });
    return await (request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? websocketOverConnection(outgoing, connection)
      : httpOverConnection(outgoing, connection));
  } catch (error) {
    await connection?.close();
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
