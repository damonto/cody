import { z } from "zod";

export const xaiAccountSchema = z
  .object({ subject: z.string().min(1) })
  .nullable()
  .optional();
export const xaiCredentialSchema = z.object({
  token: z.string().min(1),
  xai_subject: z.string().min(1),
  generation: z.number(),
});

export const xaiLimitSchema = z.object({
  model: z.string().nullable(),
  until: z.number(),
  kind: z.enum(["subscription", "spending"]),
});

export const xaiBillingSchema = z
  .object({
    monthly_limit: z.number().nullable(),
    included_used: z.number().nullable(),
    billing_period_end: z.string().nullable(),
    subscription_error: z.string().nullable().optional(),
    monthly_error: z.string().nullable().optional(),
    settings_error: z.string().nullable().optional(),
    allow_access: z.boolean().nullable().optional(),
    prepaid_balance: z.number().nonnegative().nullable().optional(),
    products: z.array(
      z.object({ product: z.string(), used_percent: z.number().nullable() }),
    ),
  })
  .optional();
