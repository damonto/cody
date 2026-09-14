/** SOCKS errors are retryable only while the transport is still establishing its tunnel. */
export class SocksProxyError extends Error {
  override readonly name = "SocksProxyError";
  constructor(
    message: string,
    readonly scope: "proxy" | "target" = "proxy",
  ) {
    super(message);
  }
}

export class ProxyUnavailableError extends Error {
  override readonly name = "ProxyUnavailableError";
  constructor(
    readonly code: "proxy_group_unavailable" | "proxy_state_unavailable",
    options?: ErrorOptions,
  ) {
    super(
      code === "proxy_group_unavailable"
        ? "No healthy proxy is available in the selected group"
        : "The proxy group state is unavailable",
      options,
    );
  }
}

export interface ProxyFailure {
  readonly status: 502 | 503;
  readonly code: ProxyUnavailableError["code"] | "proxy_connection_failed";
  readonly message: string;
}

export function proxyErrorDetails(error: unknown): ProxyFailure | undefined {
  if (error instanceof ProxyUnavailableError) {
    return { status: 503, code: error.code, message: error.message };
  }
  if (error instanceof SocksProxyError && error.scope === "proxy") {
    return {
      status: 502,
      code: "proxy_connection_failed",
      message: "The selected proxy could not establish a connection",
    };
  }
  return undefined;
}
