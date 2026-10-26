import { executeInferenceAttempt } from "./inference-attempt.ts";
import { inferenceMetadata } from "../../telemetry/inference-metadata.ts";
import { unavailableInference } from "./inference-unavailable.ts";
import {
  ProviderAvailabilityReason,
  HealthFailureScope,
} from "../health/values.ts";
import { SessionAffinityStatus } from "../routing/values.ts";

import { RequestOutcome } from "../../telemetry/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";

import type { Bindings } from "../../platform/bindings.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import { ProviderRequestError } from "../../providers/errors.ts";
import { prepareProviderRequest } from "../../providers/index.ts";
import { OAuthError } from "../../providers/oauth/schema.ts";
import type { PreparedProviderResult } from "../../providers/types.ts";
import {
  bounded,
  elapsedMs,
  errorMessage,
  type RequestLogContext,
} from "../../shared/log.ts";
import type { RequestMeter } from "../../telemetry/meter.ts";

import {
  healthFailureScope,
  recordProviderFailure,
  recordProviderSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";
import { requestProtocol, type InferencePath } from "../protocol.ts";

import {
  credentialKey,
  selectAvailableProviderWithDetails,
} from "../routing/routing.ts";

import { discardBody } from "./body.ts";

import {
  type UpstreamRetryOptions,
  type UpstreamAttemptLog,
} from "./upstream-retry.ts";
import { apiError } from "./http.ts";
import {
  hasJsonUpstreamError,
  upstreamErrorStatusFields,
  upstreamResponseFields,
  upstreamResponseLogFields,
} from "./upstream-log.ts";

import { prepareInferenceInput, upstreamBody } from "./inference-input.ts";
import {
  MAX_INFERENCE_BODY_BYTES,
  requestBodyLimit,
} from "../../shared/payload-limits.ts";
export { sessionIdForInference, upstreamBody } from "./inference-input.ts";
export type { InferencePath } from "../protocol.ts";

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
  const input = await prepareInferenceInput(
    request,
    config,
    client,
    upstreamPath,
    requestId,
    requestLog,
    requestBodyLimit(MAX_INFERENCE_BODY_BYTES, env.REQUEST_BODY_LIMIT_BYTES),
  );
  if (input instanceof Response) return input;
  const {
    rawBody,
    decodedBodyBytes,
    originalText,
    payload,
    sessionId,
    route,
    candidateProviders,
  } = input;
  const protocol = requestProtocol(request, upstreamPath);
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
  let lockedMode: "native" | "siwc" | undefined;
  const accountDeadline =
    retryOptions.attemptTimeoutMs === undefined
      ? undefined
      : Date.now() + retryOptions.attemptTimeoutMs;
  const logicalAttempts: UpstreamAttemptLog[] = [];
  let attemptCount = 0;
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
        skipXaiQuota: upstreamPath === "messages/count_tokens",
        skipClaudeQuota: upstreamPath === "messages/count_tokens",
        excludedCredentials,
        codexRequest: {
          endpoint: upstreamPath,
          transport: ProviderTransport.Http,
          payload,
          mode: lockedMode,
        },
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
      const response = await unavailableInference({
        env,
        config,
        route,
        routeForSelection,
        selection,
        excludedCredentials,
        exhausted,
        resetConsumed,
        protocol,
        model: payload.model,
        requestId,
        requestLog,
        meter,
      });
      if (response) return response;
      resetConsumed = true;
      continue;
    }
    if (exhausted) {
      await discardBody(exhausted.body);
      exhausted = undefined;
    }
    const { provider, credential: selectedCredential } = target;
    const upstreamModel = target.upstreamModel;
    meter?.requestedModel(payload.model);
    requestLog?.set({
      model: {
        requested: bounded(payload.model, 160),
        upstream: bounded(upstreamModel, 160),
        route_applied: target.routeApplied,
      },
    });

    let preparation: PreparedProviderResult;
    try {
      preparation = await prepareProviderRequest(
        provider,
        selectedCredential,
        {
          request,
          endpoint: upstreamPath,
          transport: ProviderTransport.Http,
          protocol,
          payload,
          bodyBytes: decodedBodyBytes,
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
        {
          code,
          requestId,
          ...(error instanceof ProviderRequestError && error.param
            ? { param: error.param }
            : {}),
        },
      );
    }
    if (preparation.kind === "local") return preparation.response;
    const prepared = preparation;
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
    meter?.upstreamRequest(
      prepared.inferenceMetadata ??
        inferenceMetadata({ ...payload, model: upstreamModel }, protocol),
    );
    // Freeze the selection only after provider-owned quota handling permits output.
    if (!prepared.accountSwitching) meter?.select(meterTarget);
    headers.delete("content-length");
    const modelRewritten = payload.model !== upstreamModel;
    if (modelRewritten || prepared.body !== undefined) {
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
    const { result, startedAt, accountSwitch } = await executeInferenceAttempt({
      request,
      env,
      target,
      prepared,
      body,
      protocol,
      requestId,
      context,
      retryOptions,
      accountDeadline,
      meter,
    });
    for (const attempt of result.attempts) {
      logicalAttempts.push({ ...attempt, attempt: ++attemptCount });
    }
    // Retain the final attempt even when a large account pool exceeds the log bound.
    if (logicalAttempts.length > 20)
      logicalAttempts.splice(0, logicalAttempts.length - 20);
    meter?.recordAttempts(logicalAttempts);
    if (result.response && accountSwitch) {
      const persisted = await accountSwitch.persist();
      if (persisted === "unavailable") {
        await discardBody(result.response.body);
        return apiError(
          protocol,
          503,
          "The account quota store is unavailable",
          { code: "quota_state_unavailable", requestId },
        );
      }
      if (persisted === "recorded") {
        lockedProvider = provider.id;
        lockedMode = prepared.codexMode;
        excludedCredentials.add(
          credentialKey(provider.id, selectedCredential.id),
        );
        accountSwitches.push({
          credential_id: selectedCredential.id,
          ...accountSwitch.limit,
        });
        exhausted = await accountSwitch.exhausted(result.response);
        continue;
      }
    }
    if (prepared.accountSwitching) meter?.select(meterTarget);
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
    if (!prepared.transformResponse) {
      return (
        meter?.passthroughResponse(
          upstreamResponse,
          prepared.detectResponseFormat,
        ) ?? upstreamResponse
      );
    }
    try {
      return await prepared.transformResponse(
        upstreamResponse,
        meter
          ? (metadata, terminal) => meter.observeUpstream(metadata, terminal)
          : undefined,
      );
    } catch (error) {
      meter?.diagnostic("invalid_upstream_response");
      return apiError(
        protocol,
        502,
        error instanceof ProviderRequestError
          ? error.message
          : "The selected provider returned an invalid response",
        { code: "invalid_upstream_response", requestId },
      );
    }
  }
}
