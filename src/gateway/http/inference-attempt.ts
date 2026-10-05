import { recordXaiLimit } from "../../providers/xai/availability.ts";
import { CredentialAuthType } from "../../config/values.ts";

import { recordAntigravityLimit } from "../../providers/antigravity/availability.ts";
import { claudeUsageLimit } from "../../providers/claude/limits.ts";
import { HealthFailureScope } from "../health/values.ts";

import { ProviderType } from "../../config/values.ts";

import type { Bindings } from "../../platform/bindings.ts";

import type { AccountLimit } from "../../providers/types.ts";

import type { RequestMeter } from "../../telemetry/meter.ts";
import { retryResponseUsage } from "../../telemetry/retry.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";

import {
  codexUsageLimit,
  type CodexUsageLimit,
} from "../../providers/codex/limits.ts";

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
  usageLimit: CodexUsageLimit | undefined;
  nativeLimit: AccountLimit | undefined;
  claudeLimit: ReturnType<typeof claudeUsageLimit>;
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
  const { provider, credential: selectedCredential, upstreamModel } = target;
  const { headers } = prepared;
  let usageLimit: CodexUsageLimit | undefined;
  let nativeLimit: AccountLimit | undefined;
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
      ...((provider.type === ProviderType.Antigravity ||
        provider.type === ProviderType.Xai) &&
      accountDeadline !== undefined
        ? { deadline: accountDeadline }
        : {}),
      send: async (upstreamRequest) => {
        const response = await (retryOptions.send ?? prepared.send)(
          upstreamRequest,
        );
        nativeLimit = undefined;
        if (
          (provider.type !== ProviderType.Antigravity &&
            provider.type !== ProviderType.Xai) ||
          !prepared.inspectResponse
        )
          return response;
        const inspected = await prepared.inspectResponse(
          response,
          async (limit) => {
            if (selectedCredential.auth.type === CredentialAuthType.OAuth) {
              await scheduleHealthUpdate(
                context,
                provider.type === ProviderType.Xai
                  ? recordXaiLimit(
                      env,
                      selectedCredential.auth.account_ref,
                      prepared.oauthGeneration,
                      limit,
                    )
                  : recordAntigravityLimit(
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
        nativeLimit = inspected.accountLimit;
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
      ...(provider.type === ProviderType.Antigravity ||
      provider.type === ProviderType.Xai
        ? { isTerminal: () => nativeLimit !== undefined }
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
  return { result, startedAt, usageLimit, nativeLimit, claudeLimit };
}
