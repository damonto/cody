import type { TokenUsage } from "./types.ts";

export function validImageUsage(
  usage: Pick<
    TokenUsage,
    | "input_tokens"
    | "output_tokens"
    | "cache_read_tokens"
    | "cache_write_tokens"
    | "image_input_tokens"
    | "image_output_tokens"
    | "image_cache_read_tokens"
    | "image_cache_write_tokens"
  >,
): boolean {
  const input = usage.image_input_tokens;
  const output = usage.image_output_tokens;
  const cached = usage.image_cache_read_tokens;
  const written = usage.image_cache_write_tokens;
  for (const value of [input, output, cached, written]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      return false;
  }
  for (const [child, parent] of [
    [input, usage.input_tokens],
    [output, usage.output_tokens],
    [cached, input],
    [cached, usage.cache_read_tokens],
    [written, input],
    [written, usage.cache_write_tokens],
  ]) {
    if (child !== null && parent !== null && child > parent) return false;
  }
  if (
    input !== null &&
    cached !== null &&
    written !== null &&
    cached > input - written
  )
    return false;
  // Image and cache counters overlap; their union must fit the input total.
  if (input !== null && usage.input_tokens !== null) {
    for (const [images, total] of [
      [cached, usage.cache_read_tokens],
      [written, usage.cache_write_tokens],
    ]) {
      if (
        images !== null &&
        total !== null &&
        input - images > usage.input_tokens - total
      )
        return false;
    }
    if (
      cached !== null &&
      written !== null &&
      usage.cache_read_tokens !== null &&
      usage.cache_write_tokens !== null &&
      input - cached - written >
        usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens
    )
      return false;
  }
  return true;
}

/** Image input includes both cache reads and writes; charge each token once. */
export function uncachedImageTokens(usage: TokenUsage): number | null {
  const input = usage.image_input_tokens;
  if (input === 0 || usage.uncached_input_tokens === 0) return 0;
  if (input === null) return null;
  const read =
    usage.image_cache_read_tokens ?? (usage.cache_read_tokens === 0 ? 0 : null);
  const write =
    usage.image_cache_write_tokens ??
    (usage.cache_write_tokens === 0 ? 0 : null);
  if (input === read || input === write) return 0;
  if (read === null || write === null) return null;
  return input - read - write;
}
