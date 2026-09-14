import { z } from "zod";
import type { UsageEvent } from "./types.ts";
import { record } from "./usage.ts";

const nullableNumber = z.number().nullable();
const usageSchema = z.object({
  tokens: z.object({
    input_tokens: nullableNumber,
    uncached_input_tokens: nullableNumber,
    output_tokens: nullableNumber,
    cache_read_tokens: nullableNumber,
    cache_write_tokens: nullableNumber,
    cache_write_5m_tokens: nullableNumber,
    cache_write_1h_tokens: nullableNumber,
    reasoning_tokens: nullableNumber,
  }),
  status: z.enum(["reported", "partial", "missing", "invalid"]),
  raw: z.record(z.string(), z.unknown()),
});
const costSchema = z.object({
  status: z.enum(["complete", "partial", "unpriced", "unknown"]),
  currency: z.string(),
  price_version: z.string().nullable(),
  tier_index: nullableNumber,
  context_tokens: nullableNumber,
  input_nano: nullableNumber,
  output_nano: nullableNumber,
  cache_write_nano: nullableNumber,
  cache_read_nano: nullableNumber,
  total_nano: nullableNumber,
});

/** Queue messages and persisted journals are untrusted runtime boundaries. */
const usageEventSchema = z
  .object({
    schema_version: z.literal(2),
    sequence: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    phase: z.enum(["started", "finished"]),
    request_id: z.string().min(1),
    connection_id: z.string().nullable(),
    response_id: z.string().nullable(),
    started_at: z.number().int(),
    finished_at: nullableNumber,
    client_id: z.string(),
    provider_id: z.string(),
    credential_id: z.string(),
    model: z.string(),
    requested_model: z.string(),
    reported_model: z.string(),
    endpoint: z.string(),
    method: z.string(),
    protocol: z.enum(["openai", "anthropic"]),
    transport: z.enum(["http", "sse", "websocket"]),
    kind: z.literal("inference"),
    outcome: z.enum([
      "pending",
      "success",
      "failed",
      "cancelled",
      "incomplete",
    ]),
    http_status: nullableNumber,
    diagnostic_code: z.string().nullable(),
    duration_ms: nullableNumber,
    first_response_ms: z.number().nonnegative().nullable().default(null),
    ttft_ms: nullableNumber,
    first_text_ms: nullableNumber,
    context_tokens: nullableNumber,
    context_window: nullableNumber,
    context_source: z.enum(["reported_input", "unavailable"]),
    config_revision: nullableNumber,
    observation_issue: z.string().nullable(),
    usage: usageSchema,
    billing: costSchema,
    attempts: z.array(
      z.object({
        attempt: z.number(),
        status: nullableNumber,
        duration_ms: z.number(),
        retry_delay_ms: nullableNumber,
        usage: usageSchema.nullable(),
        billing: costSchema.nullable(),
      }),
    ),
  })
  .refine(
    (event) =>
      (event.phase === "finished") === (event.finished_at !== null) &&
      (event.phase === "finished") === (event.sequence === 2),
    "Invalid usage event envelope",
  ) satisfies z.ZodType<UsageEvent>;

export function parseUsageEvent(input: unknown): UsageEvent | null {
  const kind = record(input)?.kind;
  if (typeof kind === "string" && kind !== "inference") return null;
  return usageEventSchema.parse(input);
}
