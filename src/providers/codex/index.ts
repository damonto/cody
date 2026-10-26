import { validateSiwcRequest } from "./siwc-policy.ts";
import { SIWC_RESOURCE } from "./siwc.ts";
import { codexAccountHooks } from "./account-hooks.ts";
import { codexResponsePolicy } from "./response-policy.ts";
import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../transport-values.ts";

import type { CodexProviderConfig } from "../../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
} from "../../gateway/http/http.ts";
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
  type: ProviderType.Codex,
  supports(provider, endpoint, transport) {
    if (transport === ProviderTransport.Websocket)
      return endpoint === "responses" && provider.supports_websocket;
    if (endpoint === "alpha/search") return provider.supports_web_search;
    return HTTP_ENDPOINTS.has(endpoint);
  },
  prepare(provider, credential, input, context) {
    const siwc = credential.mode === "siwc";
    if (siwc) validateSiwcRequest(input);
    const search = new URL(input.request.url).search;
    const url = siwc
      ? `${SIWC_RESOURCE}/${input.endpoint}${search}`
      : upstreamUrl(input.endpoint, search);
    const headers =
      input.transport === ProviderTransport.Websocket
        ? forwardWebSocketHeaders(input.request, credential.token)
        : forwardRequestHeaders(input.request, credential.token);
    if (!siwc) headers.set("chatgpt-account-id", credential.account_id);
    else {
      headers.delete("chatgpt-account-id");
      headers.delete("x-codex-turn-state");
      headers.delete("x-openai-actor-authorization");
    }
    // Each gateway WebSocket creates a fresh upstream connection from full
    // input. A client routing hint may belong to a previously selected account.
    if (input.transport === ProviderTransport.Websocket)
      headers.delete("x-codex-turn-state");
    headers.delete("x-openai-fedramp");
    if (!siwc && credential.is_fedramp) headers.set("x-openai-fedramp", "true");
    const account = {
      codexMode: siwc ? ("siwc" as const) : ("native" as const),
      ...(siwc
        ? {
            validateWebSocketRequest: (
              payload: Readonly<Record<string, unknown>>,
            ) =>
              validateSiwcRequest({
                endpoint: "responses",
                transport: ProviderTransport.Websocket,
                payload,
              }),
          }
        : {}),
      accountSwitching: { timeoutScope: "attempt" as const },
      ...(context?.connection
        ? {
            ...codexAccountHooks(
              credential,
              context.connection,
              context,
              headers,
            ),
            ...codexResponsePolicy(
              provider,
              context.connection.credential_id,
              context,
              input.endpoint === "responses" &&
                input.transport === ProviderTransport.Http,
              siwc ? "siwc" : "native",
            ),
          }
        : {}),
    };
    if (input.endpoint !== "models")
      return {
        url,
        headers,
        ...account,
        ...(input.endpoint === "responses" &&
        input.transport === ProviderTransport.Http
          ? { detectResponseFormat: true }
          : {}),
      };
    return {
      url,
      headers,
      ...account,
      // Keep each raw ModelInfo so Codex clients receive the account catalog.
      parseModels: (value) => ({
        data: (isRecord(value) && Array.isArray(value.models)
          ? value.models
          : []
        ).flatMap((model: unknown) =>
          isRecord(model) &&
          (!siwc || model.visibility === "list") &&
          typeof model.slug === "string"
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
