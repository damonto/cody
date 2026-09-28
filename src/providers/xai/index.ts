import { estimateInputTokens } from "./tokens.ts";
import { accountReply, accountViewSchema } from "../oauth/schema.ts";
import { ProviderType } from "../../config/values.ts";
import type { XaiProviderConfig } from "../../config/types.ts";
import { ProviderTransport } from "../transport-values.ts";
import type { ProviderAdapter } from "../types.ts";
import { ProviderRequestError } from "../errors.ts";
import { XAI_BASE, xaiHeaders } from "./api.ts";
import { translateRequest } from "./request.ts";
import { convertResponse } from "./response.ts";
import { inspectXaiResponse } from "./inspect.ts";
import { xaiModels } from "./models.ts";
import { ApiProtocol } from "../../gateway/protocol-values.ts";

export const xaiAdapter: ProviderAdapter<XaiProviderConfig> = {
  type: ProviderType.Xai,
  supports(_provider, endpoint, transport) {
    return (
      transport === ProviderTransport.Http &&
      ["responses", "messages", "models", "messages/count_tokens"].includes(
        endpoint,
      )
    );
  },
  async local(provider, input) {
    if (input.endpoint === "models") {
      const models = new Map(xaiModels().map((model) => [model.id, model]));
      return Response.json({
        data: provider.models.map((id) => {
          const model = models.get(id);
          return {
            id,
            object: "model",
            owned_by: "xai",
            display_name: model?.display_name ?? id,
          };
        }),
      });
    }
    if (input.endpoint !== "messages/count_tokens") return undefined;
    return Response.json(
      { input_tokens: await estimateInputTokens(input.payload ?? {}) },
      { headers: { "x-cody-token-count": "estimated-o200k_base" } },
    );
  },
  async prepare(provider, credential, input, context) {
    const { payload, model, clientId } = input;
    if (!payload || !model || !clientId || !context)
      throw new ProviderRequestError("xAI request context is missing", 500);
    const scope = {
      client_id: clientId,
      provider_id: provider.id,
      account_ref: credential.account_ref,
      model,
    };
    const anthropic = input.protocol === ApiProtocol.Anthropic;
    const translated = await translateRequest(
      payload,
      input.endpoint === "messages",
      scope,
      context.env.CONFIG_ENCRYPTION_KEY,
      provider.credentials.map((entry) => entry.auth.account_ref),
    );
    const headers = xaiHeaders(credential.token, credential.subject);
    headers.set("accept", "text/event-stream");
    if (input.sessionId) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${clientId}\0${input.sessionId}`),
      );
      const raw = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const session = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-5${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
      headers.set("x-grok-conv-id", session);
      translated.body.prompt_cache_key = session;
    }
    const body = JSON.stringify(translated.body);
    if (new TextEncoder().encode(body).byteLength > 16 * 1024 * 1024)
      throw new ProviderRequestError(
        "Translated xAI request exceeds 16 MiB",
        413,
        "request_too_large",
      );
    return {
      url: `${XAI_BASE}/responses`,
      headers,
      method: "POST",
      body,
      oauthGeneration: credential.generation,
      inspectResponse: async (response, onLate, signal) => {
        const invalidate = async () => {
          await accountReply(
            context.env.PROVIDER_OAUTH_ACCOUNT.getByName(
              credential.account_ref,
            ).run({
              action: "xai_auth_invalid",
              generation: credential.generation,
              token: credential.token,
            }),
            accountViewSchema,
          );
        };
        if (response.status === 401) await invalidate();
        return inspectXaiResponse(response, model, onLate, signal, invalidate);
      },
      transformResponse: (response) =>
        convertResponse(response, {
          anthropic,
          stream: payload.stream === true,
          model: String(payload.model),
          scope,
          key: context.env.CONFIG_ENCRYPTION_KEY,
          tools: translated.tools,
          signal: input.request.signal,
        }),
    };
  },
};
