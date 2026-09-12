import { z } from "zod";
import {
  modelPolicySchema,
  timeZoneSchema,
  tokenCountSchema,
} from "../billing/schema.ts";
import { REPORT_PERIODS } from "../reporting/ranges.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";

export const versionSchema = z.strictObject({ version: tokenCountSchema });
export const rollbackSchema = versionSchema.extend({
  revision: tokenCountSchema.positive(),
});
export const draftSchema = versionSchema.extend({
  config: maskedConfigurationSchema,
});
const optionalFilter = z.string().min(1).max(256).optional();
export const reportQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default("day"),
  time_zone: timeZoneSchema.optional(),
  service_id: optionalFilter,
  key_id: optionalFilter,
  client_id: optionalFilter,
  model: optionalFilter,
  kind: z.enum(["inference", "auxiliary", "catalog", "handshake"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  outcome: z
    .enum(["pending", "success", "failed", "cancelled", "incomplete"])
    .optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number<string>().int().min(1).max(100).default(50),
});

export const priceHistoryQuerySchema = z.object({
  service_id: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
});
export const priceVersionQuerySchema = z.object({
  id: z.string().min(1).max(4096),
});
export const requestIdSchema = z.object({ id: z.string().min(1).max(256) });
export const runtimeQuerySchema = z.object({
  client_id: z.string().min(1).max(256),
  scope: z.enum(["inference", "catalog"]).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  release_context_ownership: z.enum(["true", "false"]).optional(),
});
export const healthListSchema = z.object({
  object: z.literal("list"),
  scope: z.enum(["inference", "catalog"]),
  data: z.array(
    z.object({
      service_id: z.string(),
      key_id: z.string().optional(),
      failures: z.number(),
      cooling_until: z.number().nullable(),
    }),
  ),
});
export const sessionListSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      session_id: z.string(),
      service_id: z.string(),
      key_id: z.string(),
      created_at: z.number(),
      updated_at: z.number(),
      expires_at: z.number(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

const nullableCounter = tokenCountSchema
  .nullish()
  .transform((value) => value ?? null);
export const previewSchema = z.strictObject({
  policy: modelPolicySchema,
  usage: z
    .strictObject({
      input_tokens: nullableCounter,
      output_tokens: nullableCounter,
      cache_read_tokens: nullableCounter,
      cache_write_tokens: nullableCounter,
      cache_write_5m_tokens: nullableCounter,
      cache_write_1h_tokens: nullableCounter,
      reasoning_tokens: nullableCounter,
    })
    .superRefine((usage, context) => {
      const {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: write,
        reasoning_tokens: reasoning,
      } = usage;
      if (
        input !== null &&
        read !== null &&
        write !== null &&
        read + write > input
      ) {
        context.addIssue({
          code: "custom",
          path: ["input_tokens"],
          message: "Cache tokens cannot exceed total input",
        });
      }
      if (output !== null && reasoning !== null && reasoning > output) {
        context.addIssue({
          code: "custom",
          path: ["reasoning_tokens"],
          message: "Reasoning tokens cannot exceed output",
        });
      }
      if (
        usage.cache_write_5m_tokens !== null &&
        usage.cache_write_1h_tokens !== null &&
        write !== null &&
        usage.cache_write_5m_tokens + usage.cache_write_1h_tokens !== write
      ) {
        context.addIssue({
          code: "custom",
          path: ["cache_write_tokens"],
          message: "Cache duration counters must equal total cache writes",
        });
      }
    })
    .transform((usage) => ({
      ...usage,
      uncached_input_tokens:
        usage.input_tokens !== null &&
        usage.cache_read_tokens !== null &&
        usage.cache_write_tokens !== null
          ? usage.input_tokens -
            usage.cache_read_tokens -
            usage.cache_write_tokens
          : null,
    })),
});
