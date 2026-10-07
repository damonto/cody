function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extract structured upstream error codes consistently for diagnostics and retries. */
export function upstreamErrorCode(
  value: unknown,
  event = "",
): string | undefined {
  const payload = object(value);
  if (!payload) return undefined;
  const response = object(payload.response);
  const error = object(payload.error ?? response?.error);
  const type = payload.type ?? event;
  const code =
    error?.code ?? (type === "error" ? payload.code : undefined) ?? error?.type;
  return typeof code === "string" && code.length > 0 && code.length <= 256
    ? code
    : undefined;
}
