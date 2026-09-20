import type { AiGatewayProviderConfig } from "../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  upstreamUrl,
} from "../gateway/http/http.ts";
import { isContextManagementPath } from "../gateway/protocol.ts";
import type { ProviderAdapter } from "./types.ts";

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
  prepare(provider, credential, { request, endpoint, transport }) {
    return {
      url: upstreamUrl(provider, endpoint, new URL(request.url).search),
      headers:
        transport === "websocket"
          ? forwardWebSocketHeaders(request, credential.token)
          : forwardRequestHeaders(request, credential.token),
    };
  },
};
