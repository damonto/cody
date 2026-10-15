import { HealthFailureScope } from "../health/values.ts";

import type { Bindings } from "../../platform/bindings.ts";

import type {
  PreparedAccountSwitch,
  ProviderResponseInspection,
} from "../../providers/types.ts";

import type { RequestMeter } from "../../telemetry/meter.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";

import {
  fetchWithConfiguredRetries,
  type UpstreamRetryOptions,
} from "./upstream-retry.ts";

import type { ModelProviderTarget } from "../routing/routing.ts";
import type { PreparedProviderRequest } from "../../providers/types.ts";
import type { ApiProtocol } from "../protocol.ts";
import type { FetchWithRetriesResult } from "./upstream-retry.ts";

interface InferenceAttemptInput {
  request: Request;
  env: Bindings;
  target: ModelProviderTarget;
  prepared: PreparedProviderRequest;
  body: BodyInit;
  protocol: ApiProtocol;
  requestId: string;
  context: HealthExecutionContext | undefined;
  retryOptions: UpstreamRetryOptions;
  accountDeadline: number | undefined;
  meter: RequestMeter | undefined;
}
export interface InferenceAttemptResult {
  result: FetchWithRetriesResult;
  startedAt: number;
  accountSwitch: PreparedAccountSwitch | undefined;
}

/** Execute configured retries and inspect limits, without selecting or switching accounts. */
export async function executeInferenceAttempt({
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
}: InferenceAttemptInput): Promise<InferenceAttemptResult> {
  const { provider, credential: selectedCredential } = target;
  const { headers, responseInspector } = prepared;
  let inspection: ProviderResponseInspection | undefined;
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
      recoverUnauthorized: prepared.recoverUnauthorized,
      observeResponse: prepared.observeResponse,
      ...(prepared.accountSwitching?.timeoutScope === "request" &&
      accountDeadline !== undefined
        ? { deadline: accountDeadline }
        : {}),
      send: async (upstreamRequest) => {
        inspection = undefined;
        const response = await (retryOptions.send ?? prepared.send)(
          upstreamRequest,
        );
        if (responseInspector?.phase !== "transport") return response;
        inspection = await responseInspector.inspect(
          response,
          upstreamRequest.signal,
        );
        return inspection.response;
      },
      ...(meter
        ? {
            observeDiscardedResponse: (response: Response) =>
              prepared.retryUsage
                ? prepared.retryUsage(response)
                : retryResponseUsage(response, protocol, {
                    detectFormat: prepared.detectResponseFormat,
                  }),
          }
        : {}),
      inspectResponse: async (response, signal, timeoutMs) => {
        if (responseInspector?.phase === "retry") {
          inspection = await responseInspector.inspect(
            response,
            signal,
            timeoutMs,
          );
        }
        return {
          response: inspection?.response ?? response,
          terminal: inspection?.accountSwitch !== undefined,
          ...(inspection?.retry ? { retry: inspection.retry } : {}),
        };
      },
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
  if (result.response) await prepared.observeFinalResponse?.(result.response);
  return { result, startedAt, accountSwitch: inspection?.accountSwitch };
}
