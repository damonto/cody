const MAX_RETRY_AFTER_MS = 2_147_483_647;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Bounded callers retain the wire payload; these projections are observation only. */
export function upstreamError(
  value: unknown,
): Record<string, unknown> | undefined {
  const payload = object(value);
  const body = object(payload?.body);
  return object(
    payload?.error ?? body?.error ?? object(payload?.response)?.error,
  );
}

export function upstreamEventType(value: unknown, event = ""): string {
  const payload = object(value);
  if (typeof payload?.type === "string" && payload.type) return payload.type;
  if (event) return event;
  const body = object(payload?.body);
  const error =
    payload?.error ?? body?.error ?? object(payload?.response)?.error;
  if (object(error) || (typeof error === "string" && error.trim()))
    return "error";
  if (typeof payload?.code === "string" && typeof payload.message === "string")
    return "error";
  return "";
}

export function upstreamErrorHeader(
  value: unknown,
  name: string,
): string | undefined {
  const payload = object(value);
  const body = object(payload?.body);
  for (const candidate of [
    payload?.headers,
    body?.headers,
    upstreamError(value)?.headers,
  ]) {
    const headers = object(candidate);
    if (!headers) continue;
    for (const [key, value] of Object.entries(headers))
      if (
        key.toLowerCase() === name.toLowerCase() &&
        (typeof value === "string" ||
          (typeof value === "number" && Number.isFinite(value)))
      )
        return String(value);
  }
  return undefined;
}

export function upstreamErrorStatus(value: unknown): number | undefined {
  const payload = object(value);
  for (const source of [
    payload,
    object(payload?.body),
    upstreamError(value),
    object(payload?.response),
  ]) {
    for (const candidate of [
      source?.status,
      source?.status_code,
      source?.http_status,
    ]) {
      const status =
        typeof candidate === "string" && /^\d{3}$/.test(candidate)
          ? Number(candidate)
          : candidate;
      if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599
      )
        return status;
    }
  }
  return undefined;
}

/** An absolute deadline avoids extending a hint while inspecting a response. */
export function upstreamRetryAt(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const until = Number.isFinite(seconds)
    ? now + seconds * 1000
    : Date.parse(value);
  if (
    Number.isFinite(until) &&
    until > now &&
    until - now <= MAX_RETRY_AFTER_MS
  )
    return until;
  return undefined;
}

/** Extract structured upstream error codes consistently for diagnostics and retries. */
export function upstreamErrorCode(
  value: unknown,
  event = "",
): string | undefined {
  const payload = object(value);
  if (!payload) return undefined;
  const error = upstreamError(payload);
  const body = object(payload.body);
  const type = upstreamEventType(payload, event);
  const code =
    error?.code ??
    (type === "error" ? (payload.code ?? body?.code) : undefined) ??
    error?.type;
  return typeof code === "string" && code.length > 0 && code.length <= 256
    ? code
    : undefined;
}
