import {
  USAGE_FIELDS,
  type ModelPolicy,
  type NormalizedUsage,
  type TokenUsage,
} from "../billing/types.ts";
import type { ApiProtocol } from "../gateway/protocol.ts";

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function emptyUsage(): TokenUsage {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, null]),
  ) as TokenUsage;
}

const COUNTERS = [
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_tokens",
];
const DETAILS: Record<string, string[]> = {
  input_tokens_details: ["cached_tokens", "cache_write_tokens"],
  prompt_tokens_details: ["cached_tokens", "cache_write_tokens"],
  output_tokens_details: ["reasoning_tokens"],
  completion_tokens_details: ["reasoning_tokens"],
  cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
};

export class UsageAccumulator {
  private raw: Record<string, unknown> = {};

  constructor(private readonly protocol: ApiProtocol) {}

  add(value: unknown): void {
    const input = record(value);
    if (!input) return;
    for (const key of COUNTERS) {
      if (Object.hasOwn(input, key)) this.raw[key] = count(input[key]);
    }
    for (const [key, fields] of Object.entries(DETAILS)) {
      const source = record(input[key]);
      if (!source) continue;
      const destination = { ...record(this.raw[key]) };
      for (const field of fields) {
        if (Object.hasOwn(source, field))
          destination[field] = count(source[field]);
      }
      this.raw[key] = destination;
    }
  }

  snapshot(policy?: ModelPolicy): NormalizedUsage {
    const tokens = emptyUsage();
    const raw = structuredClone(this.raw);
    if (Object.keys(raw).length === 0)
      return { tokens, raw, status: "missing" };
    let invalid = false;
    if (this.protocol === "anthropic") {
      tokens.uncached_input_tokens = count(raw.input_tokens);
      tokens.output_tokens = count(raw.output_tokens);
      tokens.cache_read_tokens = count(raw.cache_read_input_tokens);
      tokens.cache_write_tokens = count(raw.cache_creation_input_tokens);
      const cache = record(raw.cache_creation);
      tokens.cache_write_5m_tokens = count(cache?.ephemeral_5m_input_tokens);
      tokens.cache_write_1h_tokens = count(cache?.ephemeral_1h_input_tokens);
      if (
        tokens.uncached_input_tokens !== null &&
        tokens.cache_read_tokens !== null &&
        tokens.cache_write_tokens !== null
      ) {
        const sum =
          tokens.uncached_input_tokens +
          tokens.cache_read_tokens +
          tokens.cache_write_tokens;
        if (Number.isSafeInteger(sum)) tokens.input_tokens = sum;
        else invalid = true;
      }
      tokens.reasoning_tokens = count(raw.reasoning_tokens);
    } else {
      tokens.input_tokens = count(raw.input_tokens ?? raw.prompt_tokens);
      tokens.output_tokens = count(raw.output_tokens ?? raw.completion_tokens);
      const input = record(
        raw.input_tokens_details ?? raw.prompt_tokens_details,
      );
      const output = record(
        raw.output_tokens_details ?? raw.completion_tokens_details,
      );
      tokens.cache_read_tokens = count(input?.cached_tokens);
      tokens.cache_write_tokens = count(input?.cache_write_tokens);
      const inputTokens = tokens.input_tokens;
      if (
        inputTokens !== null &&
        tokens.cache_read_tokens !== null &&
        input &&
        !Object.hasOwn(input, "cache_write_tokens")
      ) {
        // Compatible providers can omit writes when they have no separate
        // charge. A priced write or an explicit invalid counter stays unknown.
        const tier = policy?.pricing?.tiers.find(
          (tier) =>
            tier.up_to_input_tokens === null ||
            inputTokens <= tier.up_to_input_tokens,
        );
        if (
          tier &&
          [
            tier.cache_write,
            tier.cache_write_5m ?? tier.cache_write,
            tier.cache_write_1h ?? tier.cache_write,
          ].every((rate) => Number(rate) === 0)
        )
          tokens.cache_write_tokens = 0;
      }
      tokens.reasoning_tokens = count(
        output?.reasoning_tokens ?? raw.reasoning_tokens,
      );
      if (
        tokens.input_tokens !== null &&
        tokens.cache_read_tokens !== null &&
        tokens.cache_write_tokens !== null
      ) {
        const ordinary =
          tokens.input_tokens -
          tokens.cache_read_tokens -
          tokens.cache_write_tokens;
        if (ordinary >= 0) tokens.uncached_input_tokens = ordinary;
        else invalid = true;
      }
    }
    if (
      tokens.reasoning_tokens !== null &&
      tokens.output_tokens !== null &&
      tokens.reasoning_tokens > tokens.output_tokens
    ) {
      tokens.reasoning_tokens = null;
      invalid = true;
    }
    if (
      tokens.cache_write_5m_tokens !== null &&
      tokens.cache_write_1h_tokens !== null &&
      tokens.cache_write_tokens !== null &&
      tokens.cache_write_5m_tokens + tokens.cache_write_1h_tokens !==
        tokens.cache_write_tokens
    )
      invalid = true;
    const complete = [
      tokens.input_tokens,
      tokens.output_tokens,
      tokens.uncached_input_tokens,
      tokens.cache_read_tokens,
      tokens.cache_write_tokens,
    ].every((value) => value !== null);
    return {
      tokens,
      raw,
      status: invalid ? "invalid" : complete ? "reported" : "partial",
    };
  }
}
