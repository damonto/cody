import { z } from "zod";

export const rateSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/,
    "Use a non-negative decimal string with at most six decimal places",
  );
export const tokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format();
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA time zone");

export const reportingSchema = z.strictObject({
  time_zone: timeZoneSchema,
  retention_days: z
    .number()
    .int()
    .min(30, "Retention must be between 30 and 730 days")
    .max(730, "Retention must be between 30 and 730 days"),
});

export const priceTierSchema = z.strictObject({
  up_to_input_tokens: tokenCountSchema.positive().nullable(),
  image_input: rateSchema.optional(),
  image_output: rateSchema.optional(),
  image_cache_read: rateSchema.optional(),
  image_cache_write: rateSchema.optional(),
  input: rateSchema,
  output: rateSchema,
  cache_write: rateSchema,
  cache_read: rateSchema,
  cache_write_5m: rateSchema.optional(),
  cache_write_1h: rateSchema.optional(),
});

const pricingSchema = z.strictObject({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code"),
  tiers: z
    .array(priceTierSchema)
    .min(1)
    .max(20)
    .superRefine((tiers, context) => {
      let previous = 0;
      for (const [index, tier] of tiers.entries()) {
        const upper = tier.up_to_input_tokens;
        if ((upper === null) !== (index === tiers.length - 1)) {
          context.addIssue({
            code: "custom",
            path: [index, "up_to_input_tokens"],
            message: "Only the final tier must have a null upper bound",
          });
        }
        if (upper !== null) {
          if (upper <= previous)
            context.addIssue({
              code: "custom",
              path: [index, "up_to_input_tokens"],
              message: "Tier upper bounds must increase strictly",
            });
          previous = upper;
        }
      }
    }),
});

export const modelPriceSchema = z.strictObject({
  id: z.uuid().optional(),
  /** System-generated price version in a compiled snapshot. */
  version_id: z.uuid().optional(),
  provider_id: z.string().trim().min(1),
  model: z.string().trim().min(1),
  pricing: pricingSchema.optional(),
});

export const modelPricesSchema = z
  .array(modelPriceSchema)
  .superRefine((prices, context) => {
    const seen = new Set<string>();
    for (const [index, price] of prices.entries()) {
      const key = JSON.stringify([price.provider_id, price.model]);
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: [index],
          message: "This duplicates a provider/model price",
        });
      seen.add(key);
    }
  });

export function validateModelPriceReferences(
  prices: z.output<typeof modelPricesSchema>,
  providers: readonly { id: string; models: string[] }[],
  context: z.RefinementCtx,
): void {
  const models = new Map(
    providers.map((provider) => [provider.id, provider.models]),
  );
  for (const [index, price] of prices.entries()) {
    if (!models.get(price.provider_id)?.includes(price.model)) {
      context.addIssue({
        code: "custom",
        path: ["model_prices", index],
        message: "must reference a declared provider and one of its models",
      });
    }
  }
}

export function validationMessage(error: z.core.$ZodError): string {
  const issues = error.issues.flatMap((issue) => {
    if (
      issue.code === "invalid_union" &&
      issue.errors &&
      issue.errors.length > 0
    ) {
      return issue.errors.flat();
    }
    return [issue];
  });
  return issues
    .map(
      (issue) => `${issue.path.join(".") || "Configuration"}: ${issue.message}`,
    )
    .join("; ");
}
