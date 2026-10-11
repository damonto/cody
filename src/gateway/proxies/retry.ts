import type { SocksProxyConfig } from "../../config/types.ts";
import { abortableDelay } from "../../shared/abort.ts";
import {
  socksFetch,
  type SocksFetchOptions,
  type SocksStage,
} from "../transport/socks-fetch.ts";
import { SocksProxyError } from "./errors.ts";

const PROXY_RETRY_DELAYS_MS = [100, 300, 500] as const;

interface ProxyRetryOptions extends Omit<
  SocksFetchOptions,
  "connectTimeoutMs"
> {
  readonly deadline: number;
  readonly clientSignal: AbortSignal;
}

/** Retry one node before upstream I/O; the caller records one health outcome. */
export async function fetchWithProxyRetries(
  request: Request,
  proxy: SocksProxyConfig,
  { deadline, clientSignal, ...options }: ProxyRetryOptions,
): Promise<Response> {
  const signal = request.signal;
  let stage: SocksStage = "proxy";
  let delayMs = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      clientSignal.throwIfAborted();
      signal.throwIfAborted();
      // Timer callbacks can run late; never open another socket past the deadline.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SocksProxyError("SOCKS5 connection timed out");
      }
      return await socksFetch(request, proxy, {
        ...options,
        clientSignal,
        connectTimeoutMs: remainingMs,
        onStage(value) {
          stage = value;
          options.onStage?.(value);
        },
      });
    } catch (error) {
      clientSignal.throwIfAborted();
      // An outer deadline during backoff belongs to proxy setup, too.
      if (stage === "proxy" && signal.aborted) {
        throw new SocksProxyError("SOCKS5 connection timed out");
      }
      const nextDelayMs = PROXY_RETRY_DELAYS_MS[attempt];
      if (
        stage !== "proxy" ||
        !(error instanceof SocksProxyError) ||
        error.scope !== "proxy" ||
        nextDelayMs === undefined
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new SocksProxyError("SOCKS5 connection timed out");
      }
      delayMs = nextDelayMs;
    }
  }
}
