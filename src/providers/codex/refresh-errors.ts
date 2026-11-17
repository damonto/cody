import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import {
  ProxyUnavailableError,
  SocksProxyError,
} from "../../gateway/proxies/errors.ts";

/** Created only at the token request's transport boundary, before any possible write. */
export class CodexRefreshNotSentError extends Error {
  override readonly name = "CodexRefreshNotSentError";
}

export async function sendCodexRefresh(
  send: UpstreamFetch,
  request: Request,
): Promise<Response> {
  try {
    return await send(request);
  } catch (error) {
    const setupFailure =
      error instanceof ProxyUnavailableError ||
      error instanceof SocksProxyError;
    const connectFailure =
      error instanceof Error &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(
        String(error.cause.code),
      );
    if (setupFailure || connectFailure)
      throw new CodexRefreshNotSentError(
        "ChatGPT token request failed before sending",
        { cause: error },
      );
    throw error;
  }
}
