import type { NormalizedUsage } from "../../billing/types.ts";
import type { ProviderRetryConfig } from "../../config/types.ts";
import { elapsedMs, errorMessage } from "../../shared/log.ts";
import { SocksProxyError } from "../proxies/errors.ts";
import type { UpstreamFetch } from "../transport/index.ts";
import { discardBody } from "./body.ts";
import { inspectRetryError } from "./retry-errors.ts";
import type { RetryDiagnostic } from "../../shared/retry-diagnostic.ts";

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
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const startedAt = performance.now();
    const attempt: UpstreamAttemptLog = {
      attempt: attemptIndex + 1,
      duration_ms: 0,
    };
    const delayMs = retry?.delays_ms[attemptIndex];
    attempts.push(attempt);
    let response: Response | undefined;
    let request: Request;
    let shouldRetry = false;
    try {
      request = makeRequest();
      const remaining = remainingAttemptMs(options, startedAt);
      if (remaining !== undefined && remaining <= 0)
        throw new UpstreamAttemptTimeoutError(options.attemptTimeoutMs ?? 0);
      response = await fetchAttempt(
        request,
        remaining,
        options.send ?? ((request) => fetch(request)),
      );
      attempt.status = response.status;
      attempt.duration_ms = elapsedMs(startedAt);
    } catch (error) {
      attempt.duration_ms = elapsedMs(startedAt);
      attempt.error = errorMessage(error);
      return { attempts, error };
    }

    // Hook failures are internal errors, not upstream transport failures.
    // Release the body and preserve their original propagation semantics.
    let terminal: boolean;
    try {
      await options.onResponse?.(response, attempt.attempt);
      terminal = (await options.isTerminal?.(response)) === true;
    } catch (error) {
      await discardBody(response.body);
      throw error;
    }
    try {
      if (terminal || !retry || delayMs === undefined) {
        attempt.retry_diagnostic = {
          reason: terminal
            ? "provider_terminal"
            : !retry
              ? "policy_disabled"
              : "attempts_exhausted",
        };
        return { response, attempts };
      }

      shouldRetry = retry.status_codes.includes(response.status);
      attempt.retry_diagnostic = {
        reason: shouldRetry
          ? "status_match"
          : request.headers.has("upgrade")
            ? "upgrade"
            : "status_not_matched",
      };
      if (
        !shouldRetry &&
        retry.error_codes?.length &&
        response.status >= 200 &&
        !request.headers.has("upgrade")
      ) {
        const inspected = await inspectRetryError(
          response,
          request.signal,
          retry.error_codes,
          remainingAttemptMs(options, startedAt),
        );
        response = inspected.response;
        attempt.retry_diagnostic = inspected.diagnostic;
        shouldRetry = inspected.errorCode !== undefined;
        if (inspected.errorCode) attempt.error = inspected.errorCode;
        attempt.duration_ms = elapsedMs(startedAt);
      }
    } catch (error) {
      attempt.duration_ms = elapsedMs(startedAt);
      attempt.error = errorMessage(error);
      await discardBody(response?.body ?? null);
      return { attempts, error };
    }
    if (!shouldRetry) return { response, attempts };

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
      else await wait(boundedDelay, request.signal);
      request.signal.throwIfAborted();
    } catch (error) {
      return { attempts, error };
    }
  }
}
