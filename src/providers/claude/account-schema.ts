import { z } from "zod";

export const claudeAccountSchema = z.object({
  account_id: z.string(),
  organization_id: z.string(),
  organization_name: z.string().nullable(),
  subscription_type: z.string().nullable(),
  rate_limit_tier: z.string().nullable(),
});
export const claudeCredentialSchema = z.object({
  token: z.string().min(1),
  claude_organization_id: z.string().min(1),
  generation: z.number(),
});

export const claudeLimitsSchema = z
  .array(z.object({ model: z.string().nullable(), until: z.number() }))
  .optional();

export const claudeExtraUsageSchema = z
  .object({
    is_enabled: z.boolean(),
    monthly_limit: z.number().nonnegative().nullable(),
    disabled_reason: z.string().nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    used_credits: z.number().nullable(),
    utilization: z.number().nullable(),
  })
  .nullable()
  .optional();
