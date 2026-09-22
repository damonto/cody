import type { AiGatewayProviderConfig } from "../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  upstreamUrl,
} from "../gateway/http/http.ts";
import { isContextManagementPath } from "../gateway/protocol.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Claude enables its 1M context window through this beta. Claude Code adds it
 * itself when the user picks a `[1m]` model variant and strips the suffix
 * before sending, so the upstream model name never carries `[1m]`.
 */
export const ANTHROPIC_1M_CONTEXT_BETA = "context-1m-2025-08-07";

/**
 * Merges the 1M context beta into the forwarded `anthropic-beta` header. The
 * client's own betas are kept in order and the beta is never duplicated. The
 * body is untouched, so routing, logging, metering and digests all stay valid.
 */
function addAnthropic1mBeta(headers: Headers): void {
  const betas = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0);
  if (betas.includes(ANTHROPIC_1M_CONTEXT_BETA)) return;
  headers.set(
    "anthropic-beta",
    [...betas, ANTHROPIC_1M_CONTEXT_BETA].join(","),
  );
}

export const aiGatewayAdapter: ProviderAdapter<AiGatewayProviderConfig> = {
  type: "ai_gateway",
  supports(provider, endpoint, transport) {
    if (transport === "websocket") {
      return endpoint === "responses" && provider.supports_websocket;
    }
    if (isContextManagementPath(endpoint)) {
      return provider.supports_context_management;
    }
    if (endpoint === "alpha/search") {
      return provider.supports_web_search;
    }
    return true;
  },
  prepare(provider, credential, { request, endpoint, transport, protocol }) {
    const url = upstreamUrl(provider, endpoint, new URL(request.url).search);
    if (transport === "websocket") {
      return {
        url,
        headers: forwardWebSocketHeaders(request, credential.token),
      };
    }
    const headers = forwardRequestHeaders(request, credential.token);
    // Inference only: the model list and context-management calls carry no
    // Anthropic message body for the beta to apply to.
    if (
      provider.anthropic_1m_context &&
      protocol === "anthropic" &&
      endpoint !== "models" &&
      !isContextManagementPath(endpoint)
    ) {
      addAnthropic1mBeta(headers);
    }
    return { url, headers };
  },
};
