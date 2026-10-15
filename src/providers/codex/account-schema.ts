import { z } from "zod";

export const codexAccountSchema = z
  .object({
    account_id: z.string(),
    is_fedramp: z.boolean().optional(),
    user_id: z.string().nullable(),
    plan_type: z.string().nullable(),
    subscription_active_until: z.string().nullable(),
  })
  .nullable()
  .default(null);
export const codexCredentialSchema = z.object({
  token: z.string().min(1),
  account_id: z.string().min(1),
  is_fedramp: z.boolean().optional(),
  generation: z.number().int().nonnegative(),
});

export const resetCreditSchema = z.object({
  id: z.string(),
  reset_type: z.string().nullable(),
  status: z.string().nullable(),
  granted_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});
export type ResetCredit = z.output<typeof resetCreditSchema>;
export const resetCreditsSchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(resetCreditSchema),
  updated_at: z.number().nullable(),
  error: z.string().nullable(),
});
export type ResetCredits = z.output<typeof resetCreditsSchema>;
