import { z } from "zod";
import type { AntigravityProviderConfig } from "../../config/types.ts";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import { forwardRequestHeaders } from "../../gateway/http/http.ts";
import { requestProtocol } from "../../gateway/protocol.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import { ProviderRequestError } from "../errors.ts";
import type { ProviderAdapter } from "../types.ts";
import {
  ANTIGRAVITY_BASE,
  ANTIGRAVITY_USER_AGENT,
  parseModels,
} from "./api.ts";
import { translateRequest } from "./request.ts";
import { convertResponse, translatedUsage } from "./response.ts";

export const antigravityAdapter: ProviderAdapter<AntigravityProviderConfig> = {
  type: "antigravity",
  supports(_provider, endpoint, transport) {
    return (
      transport === "http" &&
      ["responses", "messages", "messages/count_tokens", "models"].includes(
        endpoint,
      )
    );
  },
  async prepare(provider, credential, input, context) {
    const headers = forwardRequestHeaders(input.request, credential.token);
    for (const name of [
      "content-length",
      "content-encoding",
      "content-md5",
      "digest",
      "content-digest",
      "anthropic-version",
      "anthropic-beta",
      "openai-beta",
      "accept-encoding",
    ])
      headers.delete(name);
    headers.set("content-type", "application/json");
    headers.set("user-agent", ANTIGRAVITY_USER_AGENT);
    if (input.endpoint === "models")
      return {
        url: `${ANTIGRAVITY_BASE}/v1internal:fetchAvailableModels`,
        method: "POST",
        headers,
        body: JSON.stringify({ project: credential.project_id }),
        parseModels: (value) => ({
          data: parseModels(value).map((model) => ({
            id: model.id,
            object: "model",
            display_name: model.display_name,
            context_window: model.input_token_limit,
            max_output_tokens: model.output_token_limit,
            owned_by: "antigravity",
            supports_thinking: model.supports_thinking,
            input_modalities: model.supports_images
              ? ["text", "image"]
              : ["text"],
          })),
        }),
      };
    if (
      !["responses", "messages", "messages/count_tokens"].includes(
        input.endpoint,
      ) ||
      !input.payload ||
      !input.model ||
      !input.clientId ||
      !context
    )
      throw new ProviderRequestError(
        "Antigravity request context is missing",
        500,
      );
    const payload = input.payload;
    const endpoint = z
      .enum(["responses", "messages", "messages/count_tokens"])
      .parse(input.endpoint);
    const scope = {
      client_id: input.clientId,
      provider_id: provider.id,
      account_ref: credential.account_ref,
      model: input.model,
    };
    const translated = await translateRequest(
      payload,
      endpoint,
      scope,
      context.env.CONFIG_ENCRYPTION_KEY,
      input.sessionId,
    );
    const protocol = requestProtocol(input.request, endpoint);
    const stream = payload.stream === true;
    const upstreamStream =
      stream || input.model.toLowerCase().includes("claude");
    const method =
      endpoint === "messages/count_tokens"
        ? "countTokens"
        : upstreamStream
          ? "streamGenerateContent?alt=sse"
          : "generateContent";
    const body = JSON.stringify(
      endpoint === "messages/count_tokens"
        ? { request: translated.request }
        : {
            project: credential.project_id,
            model: input.model,
            request: translated.request,
            userAgent: "antigravity",
            requestType: "agent",
            requestId: `agent-${crypto.randomUUID()}`,
          },
    );
    return {
      url: `${ANTIGRAVITY_BASE}/v1internal:${method}`,
      headers,
      method: "POST",
      body,
      retryUsage: (response) =>
        retryResponseUsage(response, protocol, (value) =>
          translatedUsage(value, protocol),
        ),
      transformResponse: async (response) => {
        if (endpoint === "messages/count_tokens" && response.ok) {
          const bytes = await readBodyWithinLimit(
            response.body,
            1024 * 1024,
            response.headers.get("content-length"),
            undefined,
            input.request.signal,
          );
          const result = z
            .object({ totalTokens: z.number().int().nonnegative() })
            .parse(JSON.parse(new TextDecoder().decode(bytes)));
          return Response.json({ input_tokens: result.totalTokens });
        }
        return convertResponse(response, {
          protocol,
          model: String(payload.model),
          scope,
          key: context.env.CONFIG_ENCRYPTION_KEY,
          tools: translated.tools,
          stream,
          request: payload,
        });
      },
    };
  },
};
