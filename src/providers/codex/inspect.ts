import { MAX_QUOTA_ERROR_BYTES } from "../../shared/payload-limits.ts";
import {
  inspectRetryError,
  type RetryErrorInspection,
} from "../../gateway/http/retry-errors.ts";
import { responseFormat } from "../../gateway/http/response-format.ts";
import {
  CODEX_QUOTA_CODES,
  SIWC_QUOTA_CODE,
  codexUsageLimitFromError,
  type CodexUsageLimit,
} from "./limits.ts";

interface CodexInspectionOptions {
  mode?: "native" | "siwc";
  signal: AbortSignal;
  timeoutMs?: number | undefined;
  errorCodes?: readonly string[] | undefined;
  detectFormat?: boolean | undefined;
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
  const format =
    responseFormat(response) ?? (options.detectFormat ? "auto" : undefined);
  const quotaResponse =
    response.status === 429 ||
    (response.ok && (format === "sse" || format === "auto"));
  if (!quotaResponse && !options.errorCodes?.length)
    return { response, diagnostic: { reason: "unsupported_response" } };

  let usageLimit: CodexUsageLimit | undefined;
  let observedUntil = 0;
  const inspected = await inspectRetryError(
    response,
    options.signal,
    [
      ...(options.errorCodes ?? []),
      ...(quotaResponse
        ? options.mode === "siwc"
          ? [SIWC_QUOTA_CODE]
          : CODEX_QUOTA_CODES
        : []),
    ],
    options.timeoutMs,
    {
      ...(format ? { format } : {}),
      ...(response.status === 429
        ? { maxBytes: MAX_QUOTA_ERROR_BYTES, format: format ?? "json" }
        : {}),
      async onEvent(value, _event, replayable) {
        if (!quotaResponse) return;
        const limit = codexUsageLimitFromError(
          value,
          (name) => response.headers.get(name),
          options.now,
          options.mode,
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
