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
    .min(100, "Retention must be between 100 and 730 days")
    .max(730, "Retention must be between 100 and 730 days"),
});

export const priceTierSchema = z.strictObject({
  up_to_input_tokens: tokenCountSchema.positive().nullable(),
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

export const modelPolicySchema = z.strictObject({
  provider_id: z.string().trim().min(1),
  model: z.string().trim().min(1),
  context_window: tokenCountSchema.positive().optional(),
  pricing: pricingSchema.optional(),
});

export const modelPoliciesSchema = z
  .array(modelPolicySchema)
  .superRefine((policies, context) => {
    const seen = new Set<string>();
    for (const [index, policy] of policies.entries()) {
      const key = JSON.stringify([policy.provider_id, policy.model]);
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: [index],
          message: "This duplicates a provider/model policy",
        });
      seen.add(key);
    }
  });

export function validateModelPolicyReferences(
  policies: z.output<typeof modelPoliciesSchema>,
  providers: readonly { id: string; models: string[] }[],
  context: z.RefinementCtx,
): void {
  const models = new Map(
    providers.map((provider) => [provider.id, provider.models]),
  );
  for (const [index, policy] of policies.entries()) {
    if (!models.get(policy.provider_id)?.includes(policy.model)) {
      context.addIssue({
        code: "custom",
        path: ["model_policies", index],
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
