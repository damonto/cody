import { BodyTooLargeError, discardBody, readBodyWithinLimit } from "./body.ts";
import type { NormalizedUsage } from "../../billing/types.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import type { RequestMeter } from "../../telemetry/meter.ts";
import { upstreamSecretValues } from "../routing/credentials.ts";
import type { UpstreamFetch } from "../transport/index.ts";
import { prepareProviderRequest } from "../../providers/index.ts";
import { SocksProxyError } from "../proxies/errors.ts";
import {
  codexTurnMetadata,
  contextManagementRequested,
  contextManagementSessionMatches,
} from "../sessions/context-management-protocol.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
  recordProviderFailure,
  recordProviderSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";
import { apiError } from "./http.ts";
import {
  bounded,
  elapsedMs,
  errorMessage,
  type RequestLogContext,
} from "../../shared/log.ts";
import { requestProtocol, type InferencePath } from "../protocol.ts";
import {
  resolveModelRoute,
  selectAvailableProviderWithDetails,
} from "../routing/routing.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ProviderRetryConfig,
} from "../../config/types.ts";
import {
  hasJsonUpstreamError,
  upstreamErrorStatusFields,
  upstreamResponseFields,
  upstreamResponseLogFields,
} from "./upstream-log.ts";

interface InferencePayload {
  [key: string]: unknown;
  model: string;
}

export type { InferencePath } from "../protocol.ts";

const MAX_INFERENCE_BODY_MIB = 96;
export const MAX_INFERENCE_BODY_BYTES = MAX_INFERENCE_BODY_MIB * 1024 * 1024;

export interface UpstreamRetryOptions {
  send?: UpstreamFetch;
  wait?: (delayMs: number) => Promise<void>;
  onResponse?: (response: Response, attempt: number) => Promise<void> | void;
  attemptTimeoutMs?: number;
  observeDiscardedResponse?: (
    response: Response,
  ) => Promise<NormalizedUsage | null>;
}

interface UpstreamAttemptLog {
  attempt: number;
  status?: number;
  duration_ms: number;
  retry_delay_ms?: number;
  error?: string;
  usage?: NormalizedUsage | null;
}

export interface FetchWithRetriesResult {
  response?: Response;
  attempts: UpstreamAttemptLog[];
  error?: unknown;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class UpstreamAttemptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`upstream request timed out after ${timeoutMs} ms`);
    this.name = "UpstreamAttemptTimeoutError";
  }
}

async function fetchAttempt(
  request: Request,
  timeoutMs: number | undefined,
  send: UpstreamFetch,
): Promise<Response> {
  request.signal.throwIfAborted();
  if (timeoutMs === undefined) {
    return send(request);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("attemptTimeoutMs must be a positive finite number");
  }

  const timeoutController = new AbortController();
  let timeoutError: UpstreamAttemptTimeoutError | undefined;
  const timeout = setTimeout(() => {
    timeoutError = new UpstreamAttemptTimeoutError(timeoutMs);
    timeoutController.abort(timeoutError);
  }, timeoutMs);
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);

  try {
    return await send(new Request(request, { signal }));
  } catch (error) {
    if (
      timeoutError &&
      !request.signal.aborted &&
      !(error instanceof SocksProxyError)
    ) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithConfiguredRetries(
  makeRequest: () => Request,
  retry: ProviderRetryConfig | undefined,
  retryOptions: UpstreamRetryOptions,
): Promise<FetchWithRetriesResult> {
  const attempts: UpstreamAttemptLog[] = [];
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const attemptStartedAt = performance.now();
    let response: Response;
    let request: Request;
    try {
      request = makeRequest();
      response = await fetchAttempt(
        request,
        retryOptions.attemptTimeoutMs,
        retryOptions.send ?? ((request) => fetch(request)),
      );
    } catch (error) {
      attempts.push({
        attempt: attemptIndex + 1,
        duration_ms: elapsedMs(attemptStartedAt),
        error: errorMessage(error),
      });
      return { attempts, error };
    }

    const attempt: UpstreamAttemptLog = {
      attempt: attemptIndex + 1,
      status: response.status,
      duration_ms: elapsedMs(attemptStartedAt),
    };
    attempts.push(attempt);
    await retryOptions.onResponse?.(response, attemptIndex + 1);
    const delayMs = retry?.delays_ms[attemptIndex];
    if (
      retry === undefined ||
      delayMs === undefined ||
      !retry.status_codes.includes(response.status)
    ) {
      return { response, attempts };
    }

    attempt.retry_delay_ms = delayMs;
    if (retryOptions.observeDiscardedResponse) {
      try {
        attempt.usage = await retryOptions.observeDiscardedResponse(response);
      } catch {
        attempt.usage = null;
      }
    }
    await discardBody(response.body);
    try {
      request.signal.throwIfAborted();
      if (retryOptions.wait) await retryOptions.wait(delayMs);
      else await wait(delayMs, request.signal);
      request.signal.throwIfAborted();
    } catch (error) {
      return { attempts, error };
    }
  }
}

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
 * Serializes the upstream request body after a model rewrite, or passes the
 * original bytes through untouched when nothing changed.
 */
export function upstreamBody(
  rawBody: Uint8Array<ArrayBuffer>,
  payload: InferencePayload,
  upstreamModel: string,
  changed: boolean,
): BodyInit {
  return changed
    ? JSON.stringify({ ...payload, model: upstreamModel })
    : rawBody;
}

export async function handleInference(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  upstreamPath: InferencePath,
  requestId = "unknown",
  context?: HealthExecutionContext,
  retryOptions: UpstreamRetryOptions = {},
  requestLog?: RequestLogContext,
  meter?: RequestMeter,
): Promise<Response> {
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
    requestLog?.warn({ outcome: "model_not_found" });
    return apiError(
      protocol,
      400,
      `Model ${payload.model} is not available for this API key`,
      { code: "model_not_found", requestId },
    );
  }
  const selection = await selectAvailableProviderWithDetails(env, route, {
    contextManagement,
    ...(sessionId
      ? {
          session: {
            clientId: client.id,
            sessionId,
          },
        }
      : {}),
  });
  const target = selection.target;
  const routing = {
    candidate_providers: candidateProviders,
    checked_available_providers: selection.checks
      .filter((check) => check.available)
      .map((check) => check.provider_id),
    provider_checks: selection.checks,
    credential_checks: selection.credentialChecks,
    ...(selection.affinity ? { affinity: selection.affinity } : {}),
    ...(target
      ? {
          selected_provider: target.provider.id,
          selected_credential_id: target.credential.id,
        }
      : {}),
  };
  if (
    selection.checks.some((check) => check.reason === "health_read_failed") ||
    selection.credentialChecks.some(
      (check) => check.reason === "health_read_failed",
    ) ||
    selection.affinity?.status === "failed"
  ) {
    requestLog?.warn({ routing });
  } else {
    requestLog?.set({ routing });
  }
  if (!target) {
    if (selection.affinity?.status === "forbidden") {
      return apiError(
        protocol,
        403,
        "This context session belongs to another client",
        { code: "context_session_forbidden", requestId },
      );
    }
    if (selection.affinity?.status === "failed") {
      return apiError(
        protocol,
        503,
        "The session binding store is unavailable",
        {
          type: "server_error",
          code: "session_affinity_unavailable",
          requestId,
        },
      );
    }
    if (selection.affinity?.status === "blocked") {
      return apiError(
        protocol,
        503,
        "The context session binding is unavailable",
        {
          type: "server_error",
          code: "context_session_unavailable",
          requestId,
        },
      );
    }
    requestLog?.warn({ outcome: "provider_cooling_down" });
    return apiError(
      protocol,
      503,
      `No healthy provider is currently available for model ${payload.model}`,
      { type: "server_error", code: "provider_cooling_down", requestId },
    );
  }
  const { provider, credential: selectedCredential } = target;
  if (
    (contextManagement || selection.affinity?.context_management) &&
    !contextManagementSessionMatches(payload, sessionId)
  ) {
    return apiError(
      protocol,
      400,
      "Context management session ids must match",
      { code: "invalid_context_management_request", requestId },
    );
  }
  const upstreamModel = target.upstreamModel;
  meter?.requestedModel(payload.model);
  requestLog?.set({
    model: {
      requested: bounded(payload.model, 160),
      upstream: bounded(upstreamModel, 160),
      route_applied: target.routeApplied,
    },
  });

  const prepared = await prepareProviderRequest(
    provider,
    selectedCredential,
    {
      request,
      endpoint: upstreamPath,
      transport: "http",
    },
    { config, env, context, requestLog, requestId },
  );
  const { headers } = prepared;
  requestLog?.set({
    upstream: {
      provider_id: provider.id,
      credential_id: selectedCredential.id,
      model: upstreamModel,
    },
  });
  meter?.select({
    providerId: provider.id,
    credentialId: selectedCredential.id,
    model: upstreamModel,
  });
  headers.delete("content-length");
  const modelRewritten = payload.model !== upstreamModel;
  if (modelRewritten) {
    headers.delete("content-md5");
    headers.delete("digest");
    headers.delete("content-digest");
    headers.delete("content-encoding");
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const body = upstreamBody(rawBody, payload, upstreamModel, modelRewritten);
  const startedAt = performance.now();
  const result = await fetchWithConfiguredRetries(
    () =>
      new Request(prepared.url, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
      }),
    provider.retry,
    {
      ...retryOptions,
      send: retryOptions.send ?? prepared.send,
      ...(meter
        ? {
            observeDiscardedResponse: (response: Response) =>
              retryResponseUsage(response, protocol),
          }
        : {}),
      onResponse: async (response, attempt) => {
        await retryOptions.onResponse?.(response, attempt);
        if (healthFailureScope(response.status, protocol) === "credential") {
          await scheduleHealthUpdate(
            context,
            recordCredentialFailure(
              env,
              provider.id,
              selectedCredential.id,
              requestId,
            ),
          );
        }
      },
    },
  );
  meter?.recordAttempts(result.attempts);
  const upstreamDurationMs = elapsedMs(startedAt);
  if (!result.response) {
    const cancelled = request.signal.aborted;
    const proxyFailure = retryOptions.send
      ? undefined
      : prepared.proxyFailure(result.error);
    const status = cancelled ? 499 : (proxyFailure?.status ?? 502);
    const code = cancelled
      ? "request_cancelled"
      : (proxyFailure?.code ?? "upstream_unavailable");
    meter?.diagnostic(code);
    if (cancelled) meter?.finish("cancelled", status);
    requestLog?.warn({
      outcome: code,
      upstream: {
        provider_id: provider.id,
        credential_id: selectedCredential.id,
        model: bounded(upstreamModel, 160),
        model_rewritten: modelRewritten,
        duration_ms: upstreamDurationMs,
        attempts: result.attempts,
        error: errorMessage(result.error),
      },
    });
    if (!cancelled && !proxyFailure) {
      await scheduleHealthUpdate(
        context,
        recordProviderFailure(env, provider.id, requestId),
      );
    }
    return apiError(
      protocol,
      status,
      cancelled
        ? "The client cancelled the request"
        : (proxyFailure?.message ??
            "The selected upstream provider could not be reached"),
      {
        type: cancelled ? "invalid_request_error" : "server_error",
        code,
        requestId,
      },
    );
  }

  const upstreamResponse = result.response;
  if (!upstreamResponse.ok) meter?.diagnostic("upstream_error");
  if (requestLog) {
    const upstreamBase = {
      provider_id: provider.id,
      credential_id: selectedCredential.id,
      model: bounded(upstreamModel, 160),
      model_rewritten: modelRewritten,
      duration_ms: upstreamDurationMs,
      attempts: result.attempts,
    };
    if (upstreamResponse.ok) {
      requestLog.set({
        outcome: "success",
        upstream: {
          ...upstreamBase,
          ...upstreamResponseFields(upstreamResponse),
        },
      });
    } else {
      requestLog.warn({
        outcome: "upstream_error",
        upstream: {
          ...upstreamBase,
          ...upstreamErrorStatusFields(upstreamResponse),
        },
      });
      if (hasJsonUpstreamError(upstreamResponse)) {
        const responseFields = upstreamResponseLogFields(upstreamResponse);
        requestLog.defer(
          responseFields.then((fields) => {
            requestLog.set({
              upstream: {
                ...upstreamBase,
                ...requestLog.limitUpstreamErrorFields(fields),
              },
            });
          }),
        );
      }
    }
  }

  if (upstreamResponse.ok) {
    await scheduleHealthUpdate(
      context,
      recordProviderSuccess(env, provider.id, requestId),
    );
  } else if (
    healthFailureScope(upstreamResponse.status, protocol) === "provider"
  ) {
    await scheduleHealthUpdate(
      context,
      recordProviderFailure(env, provider.id, requestId),
    );
  }
  return upstreamResponse;
}
