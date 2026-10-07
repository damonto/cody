import { tokenCountSchema } from "../billing/schema.ts";
import {
  UsagePhase,
  UsageTransport,
  RequestOutcome,
  ContextSource,
} from "./values.ts";
import { UsageStatus, BillingStatus } from "../billing/values.ts";
import { ApiProtocol } from "../gateway/protocol-values.ts";

import { z } from "zod";
import type { UsageEvent } from "./types.ts";
import { record } from "./usage.ts";
import {
  RETRY_EVENT_TYPE_PATTERN,
  RETRY_REASONS,
} from "../shared/retry-diagnostic.ts";

const nullableNumber = z.number().nullable();
const metadataString = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() !== "");
const inferenceMetadataSchema = z.object({
  model: metadataString.optional(),
  reasoning: z
    .object({
      effort: metadataString.optional(),
      mode: metadataString.optional(),
      budget_tokens: z
        .number()
        .int()
        .min(-1)
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .optional(),
});
const usageSchema = z.object({
  tokens: z.object({
    image_input_tokens: tokenCountSchema.nullable().default(null),
    image_output_tokens: tokenCountSchema.nullable().default(null),
    image_cache_read_tokens: tokenCountSchema.nullable().default(null),
    image_cache_write_tokens: tokenCountSchema.nullable().default(null),
    input_tokens: nullableNumber,
    uncached_input_tokens: nullableNumber,
    output_tokens: nullableNumber,
    cache_read_tokens: nullableNumber,
    cache_write_tokens: nullableNumber,
    cache_write_5m_tokens: nullableNumber,
    cache_write_1h_tokens: nullableNumber,
    reasoning_tokens: nullableNumber,
  }),
  status: z.enum(UsageStatus),
  raw: z.record(z.string(), z.unknown()),
});
const costSchema = z.object({
  status: z.enum(BillingStatus),
  currency: z.string(),
  price_version: z.string().nullable(),
  tier_index: nullableNumber,
  context_tokens: nullableNumber,
  image_input_nano: tokenCountSchema.nullable().default(null),
  image_output_nano: tokenCountSchema.nullable().default(null),
  image_cache_read_nano: tokenCountSchema.nullable().default(null),
  image_cache_write_nano: tokenCountSchema.nullable().default(null),
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
    phase: z.enum(UsagePhase),
    request_id: z.string().min(1),
    connection_id: z.string().nullable(),
    response_id: z.string().nullable(),
    started_at: z.number().int(),
    finished_at: nullableNumber,
    client_id: z.string(),
    provider_id: z.string(),
    credential_id: z.string(),
    model: z.string(),
    upstream_model: z.string().optional(),
    requested_model: z.string(),
    reported_model: z.string(),
    upstream_observation: z
      .object({
        request: inferenceMetadataSchema,
        response: inferenceMetadataSchema,
      })
      .optional(),
    endpoint: z.string(),
    method: z.string(),
    protocol: z.enum(ApiProtocol),
    transport: z.enum(UsageTransport),
    kind: z.literal("inference"),
    outcome: z.enum(RequestOutcome),
    http_status: nullableNumber,
    diagnostic_code: z.string().nullable(),
    duration_ms: nullableNumber,
    first_response_ms: z.number().nonnegative().nullable().default(null),
    ttft_ms: nullableNumber,
    first_text_ms: nullableNumber,
    context_tokens: nullableNumber,
    context_window: nullableNumber,
    context_source: z.enum(ContextSource),
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
        retry_diagnostic: z
          .object({
            reason: z.enum(RETRY_REASONS),
            event_type: z.string().regex(RETRY_EVENT_TYPE_PATTERN).optional(),
            error_code: z.string().min(1).max(256).optional(),
          })
          .optional(),
        usage: usageSchema.nullable(),
        billing: costSchema.nullable(),
      }),
    ),
  })
  .refine(
    (event) =>
      (event.phase === UsagePhase.Finished) === (event.finished_at !== null) &&
      (event.phase === UsagePhase.Finished) === (event.sequence === 2),
    "Invalid usage event envelope",
  ) satisfies z.ZodType<UsageEvent>;

export function parseUsageEvent(input: unknown): UsageEvent | null {
  const kind = record(input)?.kind;
  if (typeof kind === "string" && kind !== "inference") return null;
  return usageEventSchema.parse(input);
}
