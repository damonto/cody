import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";

import {
  bounded,
  errorMessage,
  type RequestLogContext,
} from "../../shared/log.ts";

import { requestProtocol, type InferencePath } from "../protocol.ts";
import { upstreamSecretValues } from "../routing/credentials.ts";
import { resolveModelRoute } from "../routing/routing.ts";

import {
  codexTurnMetadata,
  contextManagementRequested,
  contextManagementSessionMatches,
} from "../sessions/context-management-protocol.ts";
import { BodyTooLargeError, readBodyWithinLimit } from "./body.ts";
import { rewriteModel } from "./model-rewrite.ts";

import { apiError } from "./http.ts";

import type { ModelRoute } from "../routing/routing.ts";
export interface InferencePayload {
  [key: string]: unknown;
  model: string;
}

export type { InferencePath } from "../protocol.ts";

const MAX_INFERENCE_BODY_MIB = 96;
export const MAX_INFERENCE_BODY_BYTES = MAX_INFERENCE_BODY_MIB * 1024 * 1024;

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the session id out of an Anthropic `metadata.user_id`. Claude Code
 * sends it as a JSON string holding `device_id` and `session_id`, so without
 * this the whole Anthropic protocol resolves no session and gets no affinity.
 */
function anthropicMetadataSessionId(
  payload: InferencePayload,
): string | undefined {
  const userId = asRecord(payload.metadata)?.user_id;
  if (typeof userId === "string") {
    try {
      return nonBlankString(asRecord(JSON.parse(userId))?.session_id);
    } catch {
      return undefined;
    }
  }
  return nonBlankString(asRecord(userId)?.session_id);
}

export function sessionIdForInference(
  request: Request,
  payload: InferencePayload,
  upstreamPath: InferencePath,
): string | undefined {
  const headerSessionId = nonBlankString(request.headers.get("session-id"));
  if (headerSessionId) {
    return headerSessionId;
  }
  const clientMetadataSessionId = nonBlankString(
    asRecord(payload.client_metadata)?.session_id,
  );
  if (clientMetadataSessionId) {
    return clientMetadataSessionId;
  }
  const codexSessionId = nonBlankString(codexTurnMetadata(payload)?.session_id);
  if (codexSessionId) {
    return codexSessionId;
  }
  const metadataSessionId = anthropicMetadataSessionId(payload);
  if (metadataSessionId) {
    return metadataSessionId;
  }
  return upstreamPath === "alpha/search"
    ? nonBlankString(payload.id)
    : undefined;
}

function parseInferencePayload(text: string): InferencePayload {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  const model = (value as Record<string, unknown>).model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("request body must contain a non-empty model string");
  }
  return value as InferencePayload;
}

/**
 * Rewrites the upstream request body after a model rewrite, or passes the
 * original bytes through untouched when nothing changed. The rewrite splices
 * only the top-level `model` string in the client's own text, so large bodies
 * are never re-serialized; a body the splice cannot handle is re-serialized.
 */
export function upstreamBody(
  rawBody: Uint8Array<ArrayBuffer>,
  payload: InferencePayload,
  upstreamModel: string,
  changed: boolean,
  originalText?: string,
): BodyInit {
  if (!changed) return rawBody;
  const text = originalText ?? new TextDecoder().decode(rawBody);
  return rewriteModel(text, payload, upstreamModel);
}

export interface InferenceInput {
  rawBody: Uint8Array<ArrayBuffer>;
  originalText: string;
  payload: InferencePayload;
  contextManagement: boolean;
  sessionId: string | undefined;
  route: ModelRoute;
  candidateProviders: string[];
}

/** Validate the bounded upload and resolve its requested route before account selection. */
export async function prepareInferenceInput(
  request: Request,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  upstreamPath: InferencePath,
  requestId: string,
  requestLog?: RequestLogContext,
): Promise<InferenceInput | Response> {
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamSecretValues(config),
  ]);
  const protocol = requestProtocol(request, upstreamPath);
  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await readBodyWithinLimit(
      request.body,
      MAX_INFERENCE_BODY_BYTES,
      request.headers.get("content-length"),
      undefined,
      request.signal,
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      requestLog?.warn({
        outcome: "request_too_large",
        inference: { max_body_bytes: MAX_INFERENCE_BODY_BYTES },
      });
      return apiError(
        protocol,
        413,
        `Request body exceeds the ${MAX_INFERENCE_BODY_MIB} MiB limit`,
        { code: "request_too_large", requestId },
      );
    }
    throw error;
  }
  const originalText = new TextDecoder().decode(rawBody);
  requestLog?.mergeSection("inference", { body_bytes: rawBody.byteLength });
  let payload: InferencePayload;
  try {
    payload = parseInferencePayload(originalText);
  } catch (error) {
    requestLog?.warn({
      outcome: "invalid_request",
      error: errorMessage(error),
    });
    return apiError(
      protocol,
      400,
      error instanceof Error ? error.message : "invalid request body",
      { requestId },
    );
  }

  const contextManagement =
    upstreamPath === "responses" && contextManagementRequested(payload);
  const sessionId = sessionIdForInference(request, payload, upstreamPath);
  if (contextManagement && !sessionId) {
    return apiError(protocol, 400, "Context management requires a session id", {
      code: "invalid_context_management_request",
      requestId,
    });
  }
  if (
    contextManagement &&
    !contextManagementSessionMatches(payload, sessionId)
  ) {
    return apiError(
      protocol,
      400,
      "Context management session ids must match",
      { code: "invalid_context_management_request", requestId },
    );
  }
  const route = resolveModelRoute(config, client, payload.model, {
    payload,
    endpoint: upstreamPath,
    requiredCapabilities: [
      ...(upstreamPath === "alpha/search"
        ? ["supports_web_search" as const]
        : []),
      ...(contextManagement ? ["supports_context_management" as const] : []),
    ],
  });
  const candidateProviders = route.targets.map((target) => target.provider.id);
  requestLog?.set({
    model: {
      requested: bounded(payload.model, 160),
    },
    routing: { candidate_providers: candidateProviders },
  });
  if (route.targets.length === 0) {
    if (route.resolutionError)
      return apiError(
        protocol,
        route.resolutionError.status,
        route.resolutionError.message,
        { code: route.resolutionError.code, requestId },
      );
    requestLog?.warn({ outcome: "model_not_found" });
    return apiError(
      protocol,
      400,
      `Model ${payload.model} is not available for this API key`,
      { code: "model_not_found", requestId },
    );
  }
  return {
    rawBody,
    originalText,
    payload,
    contextManagement,
    sessionId,
    route,
    candidateProviders,
  };
}
