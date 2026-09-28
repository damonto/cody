import type { CodexProviderConfig } from "../../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
} from "../../gateway/http/http.ts";
import { isContextManagementPath } from "../../gateway/protocol.ts";
import type { ProviderAdapter, ProviderEndpoint } from "../types.ts";
import { CODEX_BASE, CODEX_CLIENT_VERSION } from "./api.ts";

/** Endpoints the Codex backend serves beyond the capability-gated ones. */
const HTTP_ENDPOINTS: ReadonlySet<ProviderEndpoint> = new Set([
  "responses",
  "responses/compact",
  "images/generations",
  "images/edits",
  "memories/trace_summarize",
  "models",
]);

function upstreamUrl(endpoint: ProviderEndpoint, search: string): string {
  const url = new URL(`${CODEX_BASE}/${endpoint}${search}`);
  // The backend filters models by client version; a client that sends none
  // (the standard model list) still needs the full account catalog.
  if (endpoint === "models" && !url.searchParams.has("client_version"))
    url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  return url.toString();
}

/**
 * Forwards Codex client requests to the ChatGPT Codex backend as they are.
 * Account authentication includes the bearer token, workspace and FedRAMP
 * marker. Bodies and responses pass through unchanged; model discovery gets
 * a default client version only when the caller supplies none.
 */
export const codexAdapter: ProviderAdapter<CodexProviderConfig> = {
  type: "codex",
  supports(provider, endpoint, transport) {
    if (transport === "websocket")
      return endpoint === "responses" && provider.supports_websocket;
    if (isContextManagementPath(endpoint))
      return provider.supports_context_management;
    if (endpoint === "alpha/search") return provider.supports_web_search;
    return HTTP_ENDPOINTS.has(endpoint);
  },
  prepare(_provider, credential, input) {
    const url = upstreamUrl(input.endpoint, new URL(input.request.url).search);
    const headers =
      input.transport === "websocket"
        ? forwardWebSocketHeaders(input.request, credential.token)
        : forwardRequestHeaders(input.request, credential.token);
    headers.set("chatgpt-account-id", credential.account_id);
    headers.delete("x-openai-fedramp");
    if (credential.is_fedramp) headers.set("x-openai-fedramp", "true");
    if (input.endpoint !== "models") return { url, headers };
    return {
      url,
      headers,
      // Keep each raw ModelInfo so Codex clients receive the account catalog.
      parseModels: (value) => ({
        data: (isRecord(value) && Array.isArray(value.models)
          ? value.models
          : []
        ).flatMap((model: unknown) =>
          isRecord(model) && typeof model.slug === "string"
            ? [
                {
                  id: model.slug,
                  object: "model",
                  owned_by: "codex",
                  ...(typeof model.display_name === "string"
                    ? { display_name: model.display_name }
                    : {}),
                  ...(typeof model.context_window === "number"
                    ? { context_window: model.context_window }
                    : {}),
                  ...(Array.isArray(model.input_modalities)
                    ? { input_modalities: model.input_modalities }
                    : {}),
                  codex: model,
                },
              ]
            : [],
        ),
      }),
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
