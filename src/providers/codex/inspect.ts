import {
  inspectRetryError,
  type RetryErrorInspection,
} from "../../gateway/http/retry-errors.ts";
import { responseFormat } from "../../gateway/http/response-format.ts";
import {
  CODEX_QUOTA_CODES,
  codexUsageLimitFromError,
  type CodexUsageLimit,
} from "./limits.ts";

const MAX_QUOTA_ERROR_BYTES = 64 * 1024;

interface CodexInspectionOptions {
  signal: AbortSignal;
  timeoutMs?: number | undefined;
  errorCodes?: readonly string[] | undefined;
  onStreamLimit?: (limit: CodexUsageLimit) => Promise<void>;
  now?: number;
}

interface CodexResponseInspection extends RetryErrorInspection {
  usageLimit?: CodexUsageLimit;
}

/** Preserve upstream bytes while sharing one bounded quota/retry preflight. */
export async function inspectCodexResponse(
  response: Response,
  options: CodexInspectionOptions,
): Promise<CodexResponseInspection> {
  const format = responseFormat(response);
  const quotaResponse =
    response.status === 429 || (response.ok && format === "sse");
  if (!quotaResponse && !options.errorCodes?.length)
    return { response, diagnostic: { reason: "unsupported_response" } };

  let usageLimit: CodexUsageLimit | undefined;
  let observedUntil = 0;
  const inspected = await inspectRetryError(
    response,
    options.signal,
    [
      ...(options.errorCodes ?? []),
      ...(quotaResponse ? CODEX_QUOTA_CODES : []),
    ],
    options.timeoutMs,
    {
      ...(response.status === 429
        ? { maxBytes: MAX_QUOTA_ERROR_BYTES, format: format ?? "json" }
        : {}),
      async onEvent(value, _event, replayable) {
        if (!quotaResponse) return;
        const limit = codexUsageLimitFromError(
          value,
          (name) => response.headers.get(name),
          options.now,
        );
        if (!limit) return;
        if (replayable) usageLimit = limit;
        else if (!usageLimit && limit.resets_at > observedUntil) {
          observedUntil = limit.resets_at;
          await options.onStreamLimit?.(limit);
        }
      },
    },
  );
  return { ...inspected, ...(usageLimit ? { usageLimit } : {}) };
}
