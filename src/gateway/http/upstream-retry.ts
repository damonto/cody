import type { NormalizedUsage } from "../../billing/types.ts";
import type { ProviderRetryConfig } from "../../config/types.ts";
import type { PreparedUpstreamRequest } from "../../providers/types.ts";
import { abortable, abortableDelay } from "../../shared/abort.ts";
import { elapsedMs, errorMessage } from "../../shared/log.ts";
import { SocksProxyError } from "../proxies/errors.ts";
import type { UpstreamFetch } from "../transport/index.ts";
import { discardBody } from "./body.ts";
import {
  inspectRetryError,
  type RetryErrorInspection,
} from "./retry-errors.ts";
import type { RetryDiagnostic } from "../../shared/retry-diagnostic.ts";

export interface UpstreamResponseInspection {
  response: Response;
  /** Terminal provider limits take precedence over configured retries. */
  terminal: boolean;
  /** Present when the provider already performed the shared retry preflight. */
  retry?: Omit<RetryErrorInspection, "response">;
}

export interface UpstreamRetryOptions {
  recoverUnauthorized?: PreparedUpstreamRequest["recoverUnauthorized"];
  observeResponse?: ((response: Response) => void) | undefined;
  send?: UpstreamFetch;
  wait?: (delayMs: number) => Promise<void>;
  onResponse?: (response: Response, attempt: number) => Promise<void> | void;
  /** Inspect provider limits and optionally share the error-code preflight. */
  inspectResponse?: (
    response: Response,
    signal: AbortSignal,
    timeoutMs: number | undefined,
  ) => Promise<UpstreamResponseInspection> | UpstreamResponseInspection;
  attemptTimeoutMs?: number;
  /** Shared pre-response deadline across an Antigravity account-switch chain. */
  deadline?: number;
  observeDiscardedResponse?: (
    response: Response,
  ) => Promise<NormalizedUsage | null>;
}

export interface UpstreamAttemptLog {
  attempt: number;
  status?: number;
  duration_ms: number;
  retry_delay_ms?: number;
  retry_diagnostic?: RetryDiagnostic;
  error?: string;
  usage?: NormalizedUsage | null;
}

export interface FetchWithRetriesResult {
  response?: Response;
  attempts: UpstreamAttemptLog[];
  error?: unknown;
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

function remainingAttemptMs(
  options: UpstreamRetryOptions,
  startedAt: number,
): number | undefined {
  if (options.deadline !== undefined) return options.deadline - Date.now();
  if (options.attemptTimeoutMs !== undefined)
    return options.attemptTimeoutMs - elapsedMs(startedAt);
  return undefined;
}

export async function fetchWithConfiguredRetries(
  makeRequest: () => Request,
  retry: ProviderRetryConfig | undefined,
  options: UpstreamRetryOptions,
): Promise<FetchWithRetriesResult> {
  const attempts: UpstreamAttemptLog[] = [];
  let recoveryAttempted = false;
  let recoveredHeaders: Headers | undefined;
  let recoveryDeadline: number | undefined;
  for (let retryIndex = 0; ;) {
    const startedAt = performance.now();
    const attempt: UpstreamAttemptLog = {
      attempt: attempts.length + 1,
      duration_ms: 0,
    };
    const delayMs = retry?.delays_ms[retryIndex];
    const attemptOptions =
      recoveryDeadline === undefined
        ? options
        : { ...options, deadline: recoveryDeadline };
    attempts.push(attempt);
    let response: Response | undefined;
    let request: Request;
    let shouldRetry = false;
    try {
      request = makeRequest();
      if (recoveredHeaders)
        request = new Request(request, { headers: recoveredHeaders });
      const remaining = remainingAttemptMs(attemptOptions, startedAt);
      if (remaining !== undefined && remaining <= 0)
        throw new UpstreamAttemptTimeoutError(options.attemptTimeoutMs ?? 0);
      response = await fetchAttempt(
        request,
        remaining,
        options.send ?? ((request) => fetch(request)),
      );
      attempt.status = response.status;
      attempt.duration_ms = elapsedMs(startedAt);
      options.observeResponse?.(response);
      if (
        response.status === 401 &&
        options.recoverUnauthorized &&
        !recoveryAttempted
      ) {
        recoveryAttempted = true;
        // Authentication recovery shares this attempt's original time budget.
        const remaining = remainingAttemptMs(attemptOptions, startedAt);
        recoveryDeadline =
          options.deadline ??
          (remaining === undefined ? undefined : Date.now() + remaining);
        if (remaining !== undefined && remaining <= 0)
          throw new UpstreamAttemptTimeoutError(options.attemptTimeoutMs ?? 0);
        const controller = new AbortController();
        const timeout = setTimeout(
          () =>
            controller.abort(
              new UpstreamAttemptTimeoutError(remaining ?? 15_000),
            ),
          remaining ?? 15_000,
        );
        try {
          const signal = AbortSignal.any([request.signal, controller.signal]);
          const recovered = await abortable(
            options.recoverUnauthorized(signal),
            signal,
          );
          if (recovered) {
            recoveredHeaders = new Headers(recovered.headers);
            await discardBody(response.body);
            attempt.duration_ms = elapsedMs(startedAt);
            attempt.retry_diagnostic = { reason: "oauth_refresh" };
            continue;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (error) {
      await discardBody(response?.body ?? null);
      attempt.duration_ms = elapsedMs(startedAt);
      attempt.error = errorMessage(error);
      return { attempts, error };
    }

    // Hook failures are internal errors, not upstream transport failures.
    // Release the body and preserve their original propagation semantics.
    try {
      await options.onResponse?.(response, attempt.attempt);
    } catch (error) {
      await discardBody(response.body);
      throw error;
    }
    try {
      const inspection = await options.inspectResponse?.(
        response,
        request.signal,
        remainingAttemptMs(attemptOptions, startedAt),
      );
      if (inspection) response = inspection.response;
      const terminal =
        inspection?.terminal === true ||
        (response.status === 401 && options.recoverUnauthorized !== undefined);
      attempt.duration_ms = elapsedMs(startedAt);
      if (terminal || !retry || delayMs === undefined) {
        let reason: RetryDiagnostic["reason"] = "attempts_exhausted";
        if (terminal) reason = "provider_terminal";
        else if (!retry) reason = "policy_disabled";
        attempt.retry_diagnostic = { reason };
        return { response, attempts };
      }

      shouldRetry = retry.status_codes.includes(response.status);
      let reason: RetryDiagnostic["reason"] = "status_not_matched";
      if (shouldRetry) reason = "status_match";
      else if (request.headers.has("upgrade")) reason = "upgrade";
      attempt.retry_diagnostic = { reason };
      if (
        !shouldRetry &&
        retry.error_codes?.length &&
        response.status >= 200 &&
        !request.headers.has("upgrade")
      ) {
        let retryInspection = inspection?.retry;
        if (!retryInspection) {
          const inspected = await inspectRetryError(
            response,
            request.signal,
            retry.error_codes,
            remainingAttemptMs(attemptOptions, startedAt),
          );
          response = inspected.response;
          retryInspection = inspected;
        }
        attempt.retry_diagnostic = retryInspection.diagnostic;
        shouldRetry = retryInspection.errorCode !== undefined;
        if (retryInspection.errorCode)
          attempt.error = retryInspection.errorCode;
        attempt.duration_ms = elapsedMs(startedAt);
      }
    } catch (error) {
      attempt.duration_ms = elapsedMs(startedAt);
      attempt.error = errorMessage(error);
      await discardBody(response?.body ?? null);
      return { attempts, error };
    }
    if (!shouldRetry) return { response, attempts };
    retryIndex += 1;
    recoveryDeadline = undefined;

    if (options.observeDiscardedResponse) {
      try {
        attempt.usage = await options.observeDiscardedResponse(response);
      } catch {
        attempt.usage = null;
      }
    }
    await discardBody(response.body);
    try {
      request.signal.throwIfAborted();
      const boundedDelay =
        options.deadline === undefined
          ? delayMs
          : Math.max(0, Math.min(delayMs, options.deadline - Date.now()));
      attempt.retry_delay_ms = boundedDelay;
      if (options.wait) await options.wait(boundedDelay);
      else await abortableDelay(boundedDelay, request.signal);
      request.signal.throwIfAborted();
    } catch (error) {
      return { attempts, error };
    }
  }
}
