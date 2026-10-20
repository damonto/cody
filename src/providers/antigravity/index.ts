import { ProviderType } from "../../config/values.ts";
import { antigravityMetadata } from "./observation.ts";
import { record } from "../../telemetry/usage.ts";
import { ProviderTransport } from "../transport-values.ts";

import { z } from "zod";
import type { AntigravityProviderConfig } from "../../config/types.ts";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import { requestProtocol } from "../../gateway/protocol.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import { ProviderRequestError } from "../errors.ts";
import type { ProviderAdapter } from "../types.ts";
import { ANTIGRAVITY_BASE, parseModels } from "./api.ts";
import { translateRequest } from "./request.ts";
import { convertResponse, translatedUsage } from "./response.ts";
import { antigravityResponsePolicy } from "./response-policy.ts";
import { antigravityUserAgent, antigravityVersion } from "./version.ts";
import { Buffer } from "node:buffer";
import {
  formatByteLimit,
  MAX_CONTROL_RESPONSE_BODY_BYTES,
  MAX_NATIVE_REQUEST_BODY_BYTES,
} from "../../shared/payload-limits.ts";

export const antigravityAdapter: ProviderAdapter<AntigravityProviderConfig> = {
  type: ProviderType.Antigravity,
  supports(_provider, endpoint, transport) {
    return (
      transport === ProviderTransport.Http &&
      ["responses", "messages", "messages/count_tokens", "models"].includes(
        endpoint,
      )
    );
  },
  validate(input) {
    if (
      input.bodyBytes !== undefined &&
      input.bodyBytes > MAX_NATIVE_REQUEST_BODY_BYTES
    )
      throw new ProviderRequestError(
        `Native provider requests must not exceed ${formatByteLimit(MAX_NATIVE_REQUEST_BODY_BYTES)}`,
        413,
        "request_too_large",
      );
  },
  async prepare(provider, credential, input, context) {
    // Match the native header set rather than forwarding client SDK fingerprints.
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "user-agent": antigravityUserAgent(
        await antigravityVersion(context?.env.CODY_CONFIG_KV, context?.context),
      ),
    });
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
      provider.credentials.map((account) => account.auth.account_ref),
      provider.sensitive_words,
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
    if (Buffer.byteLength(body, "utf8") > MAX_NATIVE_REQUEST_BODY_BYTES)
      throw new ProviderRequestError(
        `Translated Antigravity request exceeds ${formatByteLimit(MAX_NATIVE_REQUEST_BODY_BYTES)}`,
        413,
        "request_too_large",
      );
    return {
      accountSwitching: { timeoutScope: "request" },
      url: `${ANTIGRAVITY_BASE}/v1internal:${method}`,
      ...(["responses", "messages"].includes(endpoint)
        ? antigravityResponsePolicy(
            credential.account_ref,
            input.model,
            protocol,
            context,
          )
        : {}),
      headers,
      method: "POST",
      body,
      inferenceMetadata: antigravityMetadata(
        input.model,
        record(translated.request.generationConfig)?.thinkingConfig,
      ),
      retryUsage: (response) =>
        retryResponseUsage(response, protocol, {
          extract: (value) => translatedUsage(value, protocol),
        }),
      transformResponse: async (response, observe) => {
        if (endpoint === "messages/count_tokens" && response.ok) {
          const bytes = await readBodyWithinLimit(
            response.body,
            MAX_CONTROL_RESPONSE_BODY_BYTES,
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
          ...(observe ? { observe } : {}),
        });
      },
    };
  },
};
