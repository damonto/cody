import { CredentialAuthType } from "../../config/values.ts";
import {
  antigravityQuotaResetsAt,
  antigravityQuotaResponse,
  recordAntigravityLimit,
} from "../../providers/antigravity/availability.ts";
import {
  claudeUsageLimit,
  responseQuotaObservation,
} from "../../providers/claude/limits.ts";
import {
  ProviderAvailabilityReason,
  HealthFailureScope,
} from "../health/values.ts";
import { SessionAffinityStatus } from "../routing/values.ts";

import { RequestOutcome } from "../../telemetry/values.ts";
import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";

import type { NormalizedUsage } from "../../billing/types.ts";
import type { Bindings } from "../../platform/bindings.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ProviderRetryConfig,
} from "../../config/types.ts";
import { ProviderRequestError } from "../../providers/errors.ts";
import { prepareProviderRequest } from "../../providers/index.ts";
import { OAuthError } from "../../providers/oauth/schema.ts";
import type {
  AccountLimit,
  PreparedProviderRequest,
} from "../../providers/types.ts";
import {
  bounded,
  elapsedMs,
  errorMessage,
  type RequestLogContext,
} from "../../shared/log.ts";
import type { RequestMeter } from "../../telemetry/meter.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
  recordCredentialQuotaCooldown,
  recordProviderFailure,
  recordProviderSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";
import { requestProtocol, type InferencePath } from "../protocol.ts";
import { SocksProxyError } from "../proxies/errors.ts";
import { upstreamSecretValues } from "../routing/credentials.ts";
import {
  credentialKey,
  resolveModelRoute,
  selectAvailableProviderWithDetails,
} from "../routing/routing.ts";
import {
  codexUsageLimit,
  codexUsageLimitResponse,
  type CodexUsageLimit,
} from "../../providers/codex/limits.ts";
import {
  blockedCodexQuotaResetsAt,
  codexQuotaResetsAt,
  restoreCodexAccount,
} from "../../providers/codex/exhaustion.ts";
import {
  codexTurnMetadata,
  contextManagementRequested,
  contextManagementSessionMatches,
} from "../sessions/context-management-protocol.ts";
import type { UpstreamFetch } from "../transport/index.ts";
import { BodyTooLargeError, discardBody, readBodyWithinLimit } from "./body.ts";
import { rewriteModel } from "./model-rewrite.ts";
import { apiError } from "./http.ts";
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
  /** A terminal response is returned as it is, whatever the retry policy. */
  isTerminal?: (response: Response) => Promise<boolean> | boolean;
  attemptTimeoutMs?: number;
  /** Shared pre-response deadline across an Antigravity account-switch chain. */
  deadline?: number;
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
      const remaining =
        retryOptions.deadline === undefined
          ? retryOptions.attemptTimeoutMs
          : retryOptions.deadline - Date.now();
      if (remaining !== undefined && remaining <= 0)
        throw new UpstreamAttemptTimeoutError(
          retryOptions.attemptTimeoutMs ?? 0,
        );
      response = await fetchAttempt(
        request,
        remaining,
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
    const terminal = (await retryOptions.isTerminal?.(response)) === true;
    const delayMs = retry?.delays_ms[attemptIndex];
    if (
      terminal ||
      retry === undefined ||
      delayMs === undefined ||
      !retry.status_codes.includes(response.status)
    ) {
      return { response, attempts };
    }

    const boundedDelay =
      retryOptions.deadline === undefined
        ? delayMs
        : Math.max(0, Math.min(delayMs, retryOptions.deadline - Date.now()));
    attempt.retry_delay_ms = boundedDelay;
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
      if (retryOptions.wait) await retryOptions.wait(boundedDelay);
      else await wait(boundedDelay, request.signal);
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

export async function handleInference(
  request: Request,
  env: Bindings,
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
  // Native account limits may switch within the selected provider before output.
  const excludedCredentials = new Set<string>();
  const proxySwitches = new Set<string>();
  const accountSwitches: {
    credential_id: string;
    code: string;
    resets_at: number;
  }[] = [];
  let exhausted: Response | undefined;
  let resetConsumed = false;
  let lockedProvider: string | undefined;
  const accountDeadline =
    retryOptions.attemptTimeoutMs === undefined
      ? undefined
      : Date.now() + retryOptions.attemptTimeoutMs;
  let antigravityExhausted = false;
  for (;;) {
    const routeForSelection = {
      ...route,
      targets: lockedProvider
        ? route.targets.filter(
            (target) => target.provider.id === lockedProvider,
          )
        : route.targets,
    };
    const selection = await selectAvailableProviderWithDetails(
      env,
      routeForSelection,
      {
        contextManagement,
        excludedCredentials,
        ...(sessionId
          ? {
              session: {
                clientId: client.id,
                sessionId,
              },
            }
          : {}),
      },
    );
    const claude = selection.claudeQuota;
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
      ...(accountSwitches.length > 0
        ? { account_switches: accountSwitches }
        : {}),
    };
    if (
      selection.checks.some(
        (check) => check.reason === ProviderAvailabilityReason.HealthReadFailed,
      ) ||
      selection.credentialChecks.some(
        (check) => check.reason === ProviderAvailabilityReason.HealthReadFailed,
      ) ||
      selection.affinity?.status === SessionAffinityStatus.Failed
    ) {
      requestLog?.warn({ routing });
    } else {
      requestLog?.set({ routing });
    }
    if (!target) {
      if (
        antigravityExhausted ||
        routeForSelection.targets.some(
          (target) => target.provider.type === ProviderType.Antigravity,
        )
      ) {
        const until = antigravityQuotaResetsAt(routeForSelection, selection);
        if (until !== undefined) {
          if (exhausted) await discardBody(exhausted.body);
          meter?.diagnostic("usage_limit_reached");
          return antigravityQuotaResponse(protocol, until, requestId);
        }
      }
      if (!resetConsumed) {
        resetConsumed = true;
        if (
          await restoreCodexAccount(
            env,
            config,
            route.targets,
            selection,
            excludedCredentials,
            exhausted !== undefined,
            requestId,
          )
        )
          continue;
      }
      if (exhausted) {
        requestLog?.warn({ outcome: "accounts_exhausted" });
        meter?.diagnostic("usage_limit_reached");
        return exhausted;
      }
      if (selection.affinity?.status === SessionAffinityStatus.Forbidden) {
        return apiError(
          protocol,
          403,
          "This context session belongs to another client",
          { code: "context_session_forbidden", requestId },
        );
      }
      if (selection.affinity?.status === SessionAffinityStatus.Failed) {
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
      if (selection.affinity?.status === SessionAffinityStatus.Blocked) {
        const resetsAt = blockedCodexQuotaResetsAt(selection);
        if (resetsAt !== undefined) {
          requestLog?.warn({ outcome: "usage_limit_reached" });
          return codexUsageLimitResponse(resetsAt, requestId);
        }
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
      if (claude?.allBlocked) {
        const response = apiError(
          protocol,
          429,
          `Claude subscription quota exhausted${claude.until ? ` until ${new Date(claude.until).toISOString()}` : ""}`,
          { code: "usage_limit_reached", requestId },
        );
        if (claude.until)
          response.headers.set(
            "retry-after",
            String(Math.max(1, Math.ceil((claude.until - Date.now()) / 1000))),
          );
        return response;
      }
      const quotaResetsAt = codexQuotaResetsAt(
        route.targets,
        selection,
        excludedCredentials,
      );
      if (quotaResetsAt !== undefined) {
        requestLog?.warn({ outcome: "usage_limit_reached" });
        meter?.diagnostic("usage_limit_reached");
        return codexUsageLimitResponse(quotaResetsAt, requestId);
      }
      requestLog?.warn({ outcome: "provider_cooling_down" });
      return apiError(
        protocol,
        503,
        `No healthy provider is currently available for model ${payload.model}`,
        { type: "server_error", code: "provider_cooling_down", requestId },
      );
    }
    if (exhausted) {
      await discardBody(exhausted.body);
      exhausted = undefined;
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

    let prepared: PreparedProviderRequest;
    try {
      if (
        provider.type === ProviderType.Antigravity &&
        rawBody.byteLength > 16 * 1024 * 1024
      )
        throw new ProviderRequestError(
          "Antigravity requests must not exceed 16 MiB",
          413,
          "request_too_large",
        );
      prepared = await prepareProviderRequest(
        provider,
        selectedCredential,
        {
          request,
          endpoint: upstreamPath,
          transport: ProviderTransport.Http,
          protocol,
          payload,
          model: upstreamModel,
          clientId: client.id,
          sessionId,
        },
        { config, env, context, requestLog, requestId, proxySwitches },
      );
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : 503;
      const code =
        error instanceof ProviderRequestError
          ? error.code
          : "oauth_account_unavailable";
      requestLog?.warn({
        outcome: "provider_preparation_failed",
        error: { code },
      });
      meter?.diagnostic(code);
      return apiError(
        protocol,
        status,
        error instanceof ProviderRequestError || error instanceof OAuthError
          ? error.message
          : "The selected provider account is unavailable",
        { code, requestId },
      );
    }
    const { headers } = prepared;
    requestLog?.set({
      upstream: {
        provider_id: provider.id,
        credential_id: selectedCredential.id,
        model: upstreamModel,
      },
    });
    const meterTarget = {
      providerId: provider.id,
      credentialId: selectedCredential.id,
      model: upstreamModel,
    };
    // The meter freezes its first selection, so Codex waits until no account
    // switch can follow.
    if (
      provider.type !== ProviderType.Codex &&
      provider.type !== ProviderType.Antigravity &&
      provider.type !== ProviderType.Claude
    )
      meter?.select(meterTarget);
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
    const body =
      prepared.body ??
      upstreamBody(
        rawBody,
        payload,
        upstreamModel,
        modelRewritten,
        originalText,
      );
    let usageLimit: CodexUsageLimit | undefined;
    let antigravityLimit: AccountLimit | undefined;
    let claudeLimit: ReturnType<typeof claudeUsageLimit>;
    const startedAt = performance.now();
    const result = await fetchWithConfiguredRetries(
      () =>
        new Request(prepared.url, {
          method: prepared.method ?? request.method,
          headers,
          body,
          redirect: "manual",
          signal: request.signal,
        }),
      provider.retry,
      {
        ...retryOptions,
        ...(provider.type === ProviderType.Antigravity &&
        accountDeadline !== undefined
          ? { deadline: accountDeadline }
          : {}),
        send: async (upstreamRequest) => {
          const response = await (retryOptions.send ?? prepared.send)(
            upstreamRequest,
          );
          antigravityLimit = undefined;
          if (
            provider.type !== ProviderType.Antigravity ||
            !prepared.inspectResponse
          )
            return response;
          const inspected = await prepared.inspectResponse(
            response,
            async (limit) => {
              if (selectedCredential.auth.type === CredentialAuthType.OAuth) {
                await scheduleHealthUpdate(
                  context,
                  recordAntigravityLimit(
                    env,
                    selectedCredential.auth.account_ref,
                    upstreamModel,
                    limit,
                  ),
                );
              }
            },
            upstreamRequest.signal,
          );
          antigravityLimit = inspected.accountLimit;
          return inspected.response;
        },
        ...(meter
          ? {
              observeDiscardedResponse: (response: Response) =>
                prepared.retryUsage
                  ? prepared.retryUsage(response)
                  : retryResponseUsage(response, protocol),
            }
          : {}),
        ...(provider.type === ProviderType.Claude
          ? {
              isTerminal: async (response: Response) => {
                claudeLimit = claudeUsageLimit(response, upstreamModel);
                return claudeLimit !== undefined;
              },
            }
          : {}),
        ...(provider.type === ProviderType.Antigravity
          ? { isTerminal: () => antigravityLimit !== undefined }
          : {}),
        ...(provider.type === ProviderType.Codex
          ? {
              isTerminal: async (response: Response) => {
                usageLimit = await codexUsageLimit(response);
                return usageLimit !== undefined;
              },
            }
          : {}),
        onResponse: async (response, attempt) => {
          await retryOptions.onResponse?.(response, attempt);
          if (
            healthFailureScope(response.status, protocol, provider.type) ===
            HealthFailureScope.Credential
          ) {
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
    if (
      result.response &&
      antigravityLimit &&
      selectedCredential.auth.type === CredentialAuthType.OAuth
    ) {
      try {
        await recordAntigravityLimit(
          env,
          selectedCredential.auth.account_ref,
          upstreamModel,
          antigravityLimit,
        );
      } catch {
        await discardBody(result.response.body);
        return apiError(
          protocol,
          503,
          "The account quota store is unavailable",
          { code: "quota_state_unavailable", requestId },
        );
      }
      lockedProvider = provider.id;
      antigravityExhausted = true;
      excludedCredentials.add(
        credentialKey(provider.id, selectedCredential.id),
      );
      accountSwitches.push({
        credential_id: selectedCredential.id,
        ...antigravityLimit,
      });
      meter?.recordAttempts(result.attempts);
      // Keep raw upstream statuses for attempt logs, including HTTP 200 SSE errors.
      await discardBody(result.response.body);
      exhausted = antigravityQuotaResponse(
        protocol,
        antigravityLimit.resets_at,
        requestId,
      );
      continue;
    }
    if (
      result.response &&
      provider.type === ProviderType.Claude &&
      selectedCredential.auth.type === CredentialAuthType.OAuth &&
      prepared.oauthGeneration !== undefined
    ) {
      const observation = responseQuotaObservation(result.response.headers);
      if (observation)
        await env.PROVIDER_OAUTH_ACCOUNT.getByName(
          selectedCredential.auth.account_ref,
        )
          .run({
            action: "claude_usage",
            ...observation,
            generation: prepared.oauthGeneration,
          })
          .catch(() => undefined);
    }
    if (
      result.response &&
      claudeLimit &&
      selectedCredential.auth.type === CredentialAuthType.OAuth &&
      prepared.oauthGeneration !== undefined
    ) {
      const saved = await env.PROVIDER_OAUTH_ACCOUNT.getByName(
        selectedCredential.auth.account_ref,
      )
        .run({
          action: "claude_limit",
          generation: prepared.oauthGeneration,
          ...claudeLimit,
        })
        .catch(() => undefined);
      if (saved?.ok) {
        lockedProvider = provider.id;
        excludedCredentials.add(
          credentialKey(provider.id, selectedCredential.id),
        );
        accountSwitches.push({
          credential_id: selectedCredential.id,
          code: "usage_limit_reached",
          resets_at: claudeLimit.until,
        });
        exhausted = result.response;
        continue;
      }
      requestLog?.warn({ outcome: "claude_quota_write_failed" });
    }
    if (result.response && usageLimit) {
      // Awaited: the next selection must already see this account cooling.
      await recordCredentialQuotaCooldown(
        env,
        provider.id,
        selectedCredential.id,
        usageLimit.resets_at,
        requestId,
      );
      excludedCredentials.add(
        credentialKey(provider.id, selectedCredential.id),
      );
      accountSwitches.push({
        credential_id: selectedCredential.id,
        code: usageLimit.code,
        resets_at: usageLimit.resets_at,
      });
      exhausted = result.response;
      continue;
    }
    if (
      provider.type === ProviderType.Codex ||
      provider.type === ProviderType.Antigravity ||
      provider.type === ProviderType.Claude
    )
      meter?.select(meterTarget);
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
      if (cancelled) meter?.finish(RequestOutcome.Cancelled, status);
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
      healthFailureScope(upstreamResponse.status, protocol, provider.type) ===
      HealthFailureScope.Provider
    ) {
      await scheduleHealthUpdate(
        context,
        recordProviderFailure(env, provider.id, requestId),
      );
    }
    if (!prepared.transformResponse) return upstreamResponse;
    try {
      return await prepared.transformResponse(upstreamResponse);
    } catch (error) {
      meter?.diagnostic("invalid_upstream_response");
      return apiError(
        protocol,
        502,
        error instanceof ProviderRequestError
          ? error.message
          : "Antigravity returned an invalid response",
        { code: "invalid_upstream_response", requestId },
      );
    }
  }
}
