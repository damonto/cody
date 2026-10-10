/** Used when the upstream names no reset time. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60_000;
export const CODEX_QUOTA_CODES: readonly string[] = [
  "usage_limit_reached",
  "usage_not_included",
  "insufficient_quota",
];

export interface CodexUsageLimit {
  /** The upstream error type or code that marked the account as exhausted. */
  readonly code: string;
  /** Epoch milliseconds when the account can serve requests again. */
  readonly resets_at: number;
}

type HeaderLookup = (name: string) => string | null | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function finite(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? number
    : undefined;
}

/** The exhausted window's reset time from the `x-{limit}-*` header family. */
function headerResetAt(header: HeaderLookup): number | undefined {
  const limit = (header("x-codex-active-limit")?.trim() || "codex")
    .toLowerCase()
    .replaceAll("_", "-");
  const windows = (["primary", "secondary"] as const).flatMap((window) => {
    const resetAt = finite(header(`x-${limit}-${window}-reset-at`));
    return resetAt === undefined
      ? []
      : [
          {
            resetAt: resetAt * 1000,
            used: finite(header(`x-${limit}-${window}-used-percent`)) ?? 0,
          },
        ];
  });
  const exhausted = windows.filter((window) => window.used >= 100);
  const pool = exhausted.length > 0 ? exhausted : windows;
  return pool.length > 0
    ? Math.max(...pool.map((window) => window.resetAt))
    : undefined;
}

/**
 * Classifies a Codex error payload (`{error: {...}}` or a WebSocket error
 * event) as account quota exhaustion, returning when the account resets.
 */
export function codexUsageLimitFromError(
  payload: unknown,
  header: HeaderLookup,
  now = Date.now(),
): CodexUsageLimit | undefined {
  const envelope = record(payload);
  const error = record(
    envelope?.type === "response.failed"
      ? record(envelope.response)?.error
      : envelope?.error,
  );
  if (!error) return undefined;
  const type = typeof error.type === "string" ? error.type : undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  const matched = [type, code].find(
    (value) => value && CODEX_QUOTA_CODES.includes(value),
  );
  if (!matched) return undefined;
  const resetsAtSeconds = finite(error.resets_at);
  const resetsIn = finite(error.resets_in_seconds);
  const candidates = [
    resetsAtSeconds === undefined ? undefined : resetsAtSeconds * 1000,
    resetsIn === undefined ? undefined : now + resetsIn * 1000,
    headerResetAt(header),
  ];
  const resetsAt = candidates.find(
    (value): value is number => value !== undefined && value > now,
  );
  return {
    code: matched,
    resets_at: resetsAt ?? now + DEFAULT_QUOTA_COOLDOWN_MS,
  };
}

function usageLimitError(resetsAt: number, now: number) {
  return {
    type: "usage_limit_reached",
    message: "The usage limit has been reached on every Codex account",
    resets_at: Math.ceil(resetsAt / 1000),
    resets_in_seconds: Math.max(0, Math.ceil((resetsAt - now) / 1000)),
  };
}

/**
 * The 429 Codex clients expect when every account is exhausted, so they can
 * show when usage returns instead of a generic outage.
 */
export function codexUsageLimitResponse(
  resetsAt: number,
  requestId: string,
  now = Date.now(),
): Response {
  const error = usageLimitError(resetsAt, now);
  return Response.json(
    { error },
    {
      status: 429,
      headers: {
        "retry-after": String(error.resets_in_seconds),
        "x-request-id": requestId,
      },
    },
  );
}

/** The WebSocket form of {@link codexUsageLimitResponse}. */
export function codexUsageLimitEvent(
  resetsAt: number,
  now = Date.now(),
): string {
  return JSON.stringify({
    type: "error",
    status: 429,
    error: usageLimitError(resetsAt, now),
  });
}
