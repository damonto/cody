import type { AiGatewayProviderConfig } from "../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  upstreamUrl,
} from "../gateway/http/http.ts";
import {
  isContextManagementPath,
  type ApiProtocol,
} from "../gateway/protocol.ts";
import type { ProviderAdapter } from "./types.ts";

const ANTHROPIC_1M_SUFFIX = "[1m]";

/**
 * Some gateways enable Claude's 1M context only when the model name carries a
 * `[1m]` suffix. The suffix is applied at send time only: routing, logging and
 * metering keep the configured upstream model name.
 */
function sentModel(
  provider: AiGatewayProviderConfig,
  protocol: ApiProtocol,
  model: string,
): string {
  return provider.anthropic_1m_context &&
    protocol === "anthropic" &&
    !model.endsWith(ANTHROPIC_1M_SUFFIX)
    ? `${model}${ANTHROPIC_1M_SUFFIX}`
    : model;
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
  prepare(
    provider,
    credential,
    { request, endpoint, transport, protocol, payload, model },
  ) {
    const url = upstreamUrl(provider, endpoint, new URL(request.url).search);
    if (transport === "websocket") {
      return {
        url,
        headers: forwardWebSocketHeaders(request, credential.token),
      };
    }
    const headers = forwardRequestHeaders(request, credential.token);
    const upstreamModel =
      model === undefined ? undefined : sentModel(provider, protocol, model);
    if (
      payload === undefined ||
      upstreamModel === undefined ||
      upstreamModel === model
    ) {
      return { url, headers };
    }
    // The body changes, so digests computed over the client bytes are stale.
    for (const name of [
      "content-md5",
      "digest",
      "content-digest",
      "content-encoding",
    ])
      headers.delete(name);
    return {
      url,
      headers,
      body: JSON.stringify({ ...payload, model: upstreamModel }),
    };
  },
};
