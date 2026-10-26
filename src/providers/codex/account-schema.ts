import { z } from "zod";

export const codexModeSchema = z.enum(["native", "siwc"]);
export type CodexMode = z.output<typeof codexModeSchema>;

export const SIWC_DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export const hasSiwcPlanUsage = (scopes: readonly string[]): boolean =>
  scopes.includes(SIWC_DIRECT_SCOPE) && scopes.includes("resource.invoke");

export const siwcRegistrationSchema = z.object({
  issuer: z.literal("https://auth.openai.com"),
  subject: z.string().min(1),
  client_id: z
    .string()
    .min(1)
    .refine(
      (value) => value !== "dynamic_agent_client" && value === value.trim(),
    ),
  scopes: z.array(z.string()).readonly(),
});
export const siwcSessionSchema = z.object({
  authorization_generation: z.number().int().nonnegative(),
  nonce: z.string().min(1),
  host_id: z.string().min(1),
  client_id: z.string().nullable(),
  consent: z.boolean(),
  registration: siwcRegistrationSchema.optional(),
  email: z.string().nullable().optional(),
});

const codexAccountFields = {
  user_id: z.string().nullable(),
  plan_type: z.string().nullable(),
  subscription_active_until: z.string().nullable(),
};
export const codexAccountSchema = z
  .discriminatedUnion("mode", [
    z.object({
      ...codexAccountFields,
      mode: z.literal("native").default("native"),
      account_id: z.string().min(1),
      is_fedramp: z.boolean().optional(),
      siwc: z.undefined().optional(),
      plan_usage_enabled: z.undefined().optional(),
    }),
    z.object({
      ...codexAccountFields,
      mode: z.literal("siwc"),
      account_id: z.null(),
      is_fedramp: z.undefined().optional(),
      siwc: siwcRegistrationSchema,
      plan_usage_enabled: z.boolean(),
    }),
  ])
  .nullable()
  .default(null);
export const nativeCodexCredentialSchema = z.object({
  mode: z.literal("native").optional(),
  token: z.string().min(1),
  account_id: z.string().min(1),
  is_fedramp: z.boolean().optional(),
  generation: z.number().int().nonnegative(),
});

export const siwcCredentialSchema = z.object({
  mode: z.literal("siwc"),
  token: z.string().min(1),
  siwc_subject: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export const codexCredentialSchema = z.union([
  siwcCredentialSchema,
  nativeCodexCredentialSchema,
]);

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
