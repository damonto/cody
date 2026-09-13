import { z } from "zod";
import { timeZoneSchema } from "../billing/schema.ts";
import { MAX_CUSTOM_RANGE_MS, REPORT_PERIODS } from "./ranges.ts";

const optionalFilter = z.string().min(1).max(256).optional();
const reportTimestamp = z.coerce
  .number<string>()
  .int()
  .min(0)
  .max(8_640_000_000_000_000);
const reportCurrency = z.string().regex(/^[A-Z]{3}$/);

export const reportQuerySchema = z
  .object({
    period: z.enum(REPORT_PERIODS).default("day"),
    from: reportTimestamp.optional(),
    to: reportTimestamp.optional(),
    time_zone: timeZoneSchema.optional(),
    service_id: optionalFilter,
    key_id: optionalFilter,
    client_id: optionalFilter,
    model: optionalFilter,
    currency: reportCurrency.optional(),
    cost_currency: reportCurrency.optional(),
    group_by: z
      .enum(["service_id", "model", "client_id"])
      .default("service_id"),
    sort_by: z.enum(["requests", "tokens", "cost"]).default("requests"),
    quality: z.enum(["missing_usage", "incomplete_pricing"]).optional(),
    outcome: z
      .enum(["pending", "success", "failed", "cancelled", "incomplete"])
      .optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number<string>().int().min(1).max(100).default(50),
  })
  .superRefine((query, context) => {
    if (query.period === "custom") {
      if (query.from === undefined || query.to === undefined) {
        context.addIssue({
          code: "custom",
          path: ["from"],
          message: "Custom reports require both from and to",
        });
      } else if (
        query.to <= query.from ||
        query.to - query.from > MAX_CUSTOM_RANGE_MS
      ) {
        context.addIssue({
          code: "custom",
          path: ["to"],
          message: "The end must follow the start by no more than 366 days",
        });
      }
    } else if (query.from !== undefined || query.to !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["period"],
        message: "Explicit from and to require the custom period",
      });
    }
  });

export type ReportQuery = z.output<typeof reportQuerySchema>;
export type ReportQueryParams = z.input<typeof reportQuerySchema>;
