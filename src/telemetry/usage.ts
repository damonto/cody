import type { MeteredInferencePath } from "../gateway/protocol.ts";
import { validImageUsage } from "../billing/image-usage.ts";
import { UsageStatus } from "../billing/values.ts";
import { ApiProtocol } from "../gateway/protocol-values.ts";

import {
  USAGE_FIELDS,
  type ModelPrice,
  type NormalizedUsage,
  type TokenUsage,
} from "../billing/types.ts";

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
  input_tokens_details: ["cached_tokens", "cache_write_tokens", "image_tokens"],
  prompt_tokens_details: [
    "cached_tokens",
    "cache_write_tokens",
    "image_tokens",
  ],
  output_tokens_details: ["reasoning_tokens", "image_tokens"],
  completion_tokens_details: ["reasoning_tokens", "image_tokens"],
  cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
};

export class UsageAccumulator {
  private raw: Record<string, unknown> = {};

  constructor(
    private readonly protocol: ApiProtocol,
    private readonly endpoint?: MeteredInferencePath,
  ) {}

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
      if (key === "input_tokens_details" || key === "prompt_tokens_details") {
        for (const detail of [
          "cached_tokens_details",
          "cache_write_tokens_details",
        ]) {
          const sourceDetails = record(source[detail]);
          if (!sourceDetails) continue;
          const counters = { ...record(destination[detail]) };
          for (const field of ["image_tokens", "text_tokens"]) {
            if (Object.hasOwn(sourceDetails, field))
              counters[field] = count(sourceDetails[field]);
          }
          destination[detail] = counters;
        }
      }
      this.raw[key] = destination;
    }
  }

  snapshot(price?: ModelPrice): NormalizedUsage {
    const tokens = emptyUsage();
    // Counters are primitive values and detail objects are never mutated in
    // place by add(), so a shallow copy safely isolates subsequent snapshots.
    const raw: Record<string, unknown> = { ...this.raw };
    if (Object.keys(raw).length === 0)
      return { tokens, raw, status: UsageStatus.Missing };
    let invalid = false;
    if (this.protocol === ApiProtocol.Anthropic) {
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
      for (const [field, counter, detailsKey] of [
        ["cache_read_tokens", "cached_tokens", "cached_tokens_details"],
        [
          "cache_write_tokens",
          "cache_write_tokens",
          "cache_write_tokens_details",
        ],
      ] as const) {
        tokens[field] = count(input?.[counter]);
        if (!input || Object.hasOwn(input, counter)) continue;
        const details = record(input[detailsKey]);
        if (!details) continue;
        const image = count(details.image_tokens);
        const text = count(details.text_tokens);
        if (image !== null && text !== null) {
          const sum = image + text;
          if (Number.isSafeInteger(sum)) tokens[field] = sum;
          else invalid = true;
        }
      }
      const inputTokens = tokens.input_tokens;
      if (
        inputTokens !== null &&
        tokens.cache_read_tokens !== null &&
        input &&
        !Object.hasOwn(input, "cache_write_tokens") &&
        !Object.hasOwn(input, "cache_write_tokens_details")
      ) {
        // Compatible providers can omit writes when they have no separate
        // charge. A priced write or an explicit invalid counter stays unknown.
        const tier = price?.pricing?.tiers.find(
          (tier) =>
            tier.up_to_input_tokens === null ||
            inputTokens <= tier.up_to_input_tokens,
        );
        if (
          tier &&
          [
            tier.cache_write,
            tier.image_cache_write ?? tier.cache_write,
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
    const inputDetails = record(
      raw.input_tokens_details ?? raw.prompt_tokens_details,
    );
    const outputDetails = record(
      raw.output_tokens_details ?? raw.completion_tokens_details,
    );
    const cachedDetails = record(inputDetails?.cached_tokens_details);
    const writtenDetails = record(inputDetails?.cache_write_tokens_details);
    const imageCounter = (
      details: Record<string, unknown> | undefined,
      total: number | null,
    ): number | null => {
      if (details && Object.hasOwn(details, "image_tokens")) {
        const value = count(details.image_tokens);
        if (value === null) invalid = true;
        return value;
      }
      return total === 0 ? 0 : null;
    };
    tokens.image_input_tokens = imageCounter(inputDetails, tokens.input_tokens);
    tokens.image_output_tokens = imageCounter(
      outputDetails,
      tokens.output_tokens,
    );
    tokens.image_cache_read_tokens = imageCounter(
      cachedDetails,
      tokens.cache_read_tokens,
    );
    tokens.image_cache_write_tokens = imageCounter(
      writtenDetails,
      tokens.cache_write_tokens,
    );
    if (
      tokens.image_input_tokens === 0 &&
      !Object.hasOwn(writtenDetails ?? {}, "image_tokens")
    )
      tokens.image_cache_write_tokens = 0;
    if (
      tokens.image_input_tokens === 0 &&
      !Object.hasOwn(cachedDetails ?? {}, "image_tokens")
    )
      tokens.image_cache_read_tokens = 0;
    if (
      (this.endpoint === "images/generations" ||
        this.endpoint === "images/edits") &&
      !Object.hasOwn(outputDetails ?? {}, "image_tokens")
    )
      tokens.image_output_tokens = tokens.output_tokens;
    for (const [details, total, image] of [
      [cachedDetails, tokens.cache_read_tokens, tokens.image_cache_read_tokens],
      [
        writtenDetails,
        tokens.cache_write_tokens,
        tokens.image_cache_write_tokens,
      ],
    ] as const) {
      if (!details || !Object.hasOwn(details, "text_tokens")) continue;
      const text = count(details.text_tokens);
      if (text === null || (total !== null && text > total)) invalid = true;
      if (
        text !== null &&
        total !== null &&
        image !== null &&
        text !== total - image
      )
        invalid = true;
    }
    if (!validImageUsage(tokens)) invalid = true;
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
      status: invalid
        ? UsageStatus.Invalid
        : complete
          ? UsageStatus.Reported
          : UsageStatus.Partial,
    };
  }
}
