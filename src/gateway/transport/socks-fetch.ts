import type { SocksProxyConfig } from "../../config/types.ts";
import { openSocksTunnel, type SocksDial } from "./socks.ts";
import { httpOverConnection } from "./http.ts";
import { websocketOverConnection } from "./websocket.ts";
import type { Connection } from "./bytes.ts";
import { SocksProxyError } from "../proxies/errors.ts";

export const DEFAULT_SOCKS_CONNECT_TIMEOUT_MS = 15_000;
export type SocksStage = "proxy" | "upstream" | "request";

export interface SocksFetchOptions {
  readonly dial?: SocksDial;
  /** Extra trusted roots for local integration fixtures; never a configuration option. */
  readonly trustedCertificates?: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly clientSignal?: AbortSignal;
  readonly onStage?: (stage: SocksStage) => void;
  readonly onTunnelEstablished?: () => void;
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
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_SOCKS_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new RangeError(
      "SOCKS5 connection timeout must be positive and finite",
    );
  }
  let stage: SocksStage = "proxy";
  const deadline = new AbortController();
  const timeout = setTimeout(
    () =>
      deadline.abort(
        stage === "proxy"
          ? new SocksProxyError("SOCKS5 connection timed out")
          : new Error("Upstream TLS connection timed out"),
      ),
    connectTimeoutMs,
  );
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let connection: Connection | undefined;
  try {
    options.onStage?.("proxy");
    connection = await openSocksTunnel(
      proxy,
      {
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      },
      signal,
      options.dial,
    );
    options.onTunnelEstablished?.();
    stage = "upstream";
    options.onStage?.(stage);
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
    stage = "request";
    options.onStage?.(stage);
    const outgoing = new Request(request, { signal });
    return await (request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? websocketOverConnection(outgoing, connection)
      : httpOverConnection(outgoing, connection));
  } catch (error) {
    await connection?.close();
    if (
      stage === "proxy" &&
      signal.aborted &&
      options.clientSignal &&
      !options.clientSignal.aborted
    ) {
      throw new SocksProxyError("SOCKS5 connection timed out");
    }
    signal.throwIfAborted();
    if (stage !== "proxy" && error instanceof SocksProxyError) {
      throw new Error("Upstream connection failed", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
