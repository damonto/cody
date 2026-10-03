import { ProviderType } from "../../config/values.ts";
import {
  OAuthFlow,
  OAuthAccountViewStatus,
  OAuthSessionStatus,
  ConsumeResetCode,
} from "./values.ts";
import { HealthCooldownReason } from "../../gateway/health/values.ts";

import { z } from "zod";
import { antigravityVerificationSchema } from "../../shared/antigravity-verification.ts";
import { identifierSchema, proxyGroupSchema } from "../../config/schema.ts";

export const connectionSchema = z.object({
  provider_id: identifierSchema,
  credential_id: identifierSchema,
  provider_proxy_group: identifierSchema.nullable().optional(),
  credential_proxy_group: identifierSchema.nullable().optional(),
});
export type ProviderConnection = z.output<typeof connectionSchema>;
export const oauthProviderTypeSchema = z.enum([
  ProviderType.Antigravity,
  ProviderType.Codex,
  ProviderType.Claude,
  ProviderType.Xai,
]);
export type OAuthProviderType = z.output<typeof oauthProviderTypeSchema>;
export const proxyConfigurationSchema = z.object({
  proxy_groups: z.array(proxyGroupSchema).default([]),
  revision: z.number().int().nonnegative().optional(),
});
export type ProxyConfiguration = z.output<typeof proxyConfigurationSchema>;
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_at: z.number(),
});
export const identitySchema = z.object({
  id: z.string().min(1),
  email: z.email().nullable(),
});
export const modelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
  input_token_limit: z.number().positive().nullable(),
  output_token_limit: z.number().positive().nullable(),
  supports_thinking: z.boolean().nullable().default(null),
  supports_images: z.boolean().nullable().default(null),
});
export type AccountModel = z.output<typeof modelSchema>;
export const quotaBucketSchema = z.object({
  id: z.string(),
  label: z.string(),
  window: z.string().nullable(),
  remaining_fraction: z.number().min(0).max(1).nullable(),
  reset_at: z.string().nullable(),
  used_percent: z.number().nullable().optional(),
  window_seconds: z.number().nullable().optional(),
});
export const quotaGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  buckets: z.array(quotaBucketSchema),
  limit_reached: z.boolean().optional(),
  model: z.string().nullable().optional(),
});
export const subscriptionSchema = z.object({
  tier_id: z.string().nullable(),
  tier_name: z.string().nullable(),
  credits: z.array(
    z.object({
      type: z.string().nullable(),
      amount: z.union([z.number(), z.string()]).nullable(),
    }),
  ),
  active_until: z.string().nullable().optional(),
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
export const xaiLimitSchema = z.object({
  model: z.string().nullable(),
  until: z.number(),
  kind: z.enum(["subscription", "spending"]),
});
export const quotaSnapshotSchema = z.object({
  groups: z.array(quotaGroupSchema),
  subscription: subscriptionSchema.nullable(),
  updated_at: z.number().nullable(),
  last_error: z.string().nullable(),
  verification: z.array(antigravityVerificationSchema).optional(),
  stale: z.boolean(),
  limit_reached: z.boolean().optional(),
  credits_balance: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable()
    .optional(),
  xai_limits: z.array(xaiLimitSchema).optional(),
  xai_billing: z
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
    .optional(),
  claude_limits: z
    .array(z.object({ model: z.string().nullable(), until: z.number() }))
    .optional(),
  extra_usage: z
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
    .optional(),
  reset_credits: resetCreditsSchema.nullable().optional(),
});
export type QuotaSnapshot = z.output<typeof quotaSnapshotSchema>;
export const claudeAccountSchema = z.object({
  account_id: z.string(),
  organization_id: z.string(),
  organization_name: z.string().nullable(),
  subscription_type: z.string().nullable(),
  rate_limit_tier: z.string().nullable(),
});
export const accountViewSchema = z.object({
  generation: z.number().optional(),
  account_ref: z.uuid(),
  provider_id: identifierSchema,
  status: z.enum(OAuthAccountViewStatus),
  email: z.string().nullable(),
  project_id: z.string().nullable(),
  project_initialization: z
    .object({
      status: z.enum(["pending", "error"]),
      next_retry_at: z.number().nullable(),
      error: z.string().nullable(),
      verification: z.array(antigravityVerificationSchema).optional(),
    })
    .nullable()
    .optional(),
  xai: z
    .object({ subject: z.string().min(1) })
    .nullable()
    .optional(),
  claude: claudeAccountSchema.nullable().optional(),
  codex: z
    .object({
      account_id: z.string(),
      is_fedramp: z.boolean().optional(),
      user_id: z.string().nullable(),
      plan_type: z.string().nullable(),
      subscription_active_until: z.string().nullable(),
    })
    .nullable()
    .default(null),
  expires_at: z.number().nullable(),
  error: z.string().nullable(),
  models: z.array(modelSchema),
  models_updated_at: z.number().nullable(),
  models_error: z.string().nullable(),
  models_verification: z.array(antigravityVerificationSchema).optional(),
  quota: quotaSnapshotSchema,
});
export type AccountView = z.output<typeof accountViewSchema>;
/** Minimal credential readiness; never includes account metadata or tokens. */
export const accountReadinessSchema = z.object({ ready: z.boolean() });
export const sessionStatusSchema = z.enum(OAuthSessionStatus);
export const sessionViewSchema = z.object({
  id: z.string(),
  account_ref: z.uuid(),
  status: sessionStatusSchema,
  expires_at: z.number(),
  url: z.string().nullable(),
  flow: z.enum(OAuthFlow).default(OAuthFlow.Pkce),
  user_code: z.string().nullable().default(null),
  verification_uri: z.string().nullable().default(null),
  error: z.string().nullable(),
  can_retry: z.boolean(),
  account: accountViewSchema,
});
export type SessionView = z.output<typeof sessionViewSchema>;
export const resolvedOAuthSchema = z.union([
  z.object({
    token: z.string().min(1),
    xai_subject: z.string().min(1),
    generation: z.number(),
  }),
  z.object({
    token: z.string().min(1),
    claude_organization_id: z.string().min(1),
    generation: z.number(),
  }),
  z.object({ token: z.string().min(1), project_id: z.string().min(1) }),
  z.object({
    token: z.string().min(1),
    account_id: z.string().min(1),
    is_fedramp: z.boolean().optional(),
  }),
]);
export const consumeResetResultSchema = z.object({
  code: z.enum(ConsumeResetCode),
  windows_reset: z.number().int().nonnegative().default(0),
});
export type ConsumeResetResult = z.output<typeof consumeResetResultSchema>;
export const consumeResetReplySchema = z.object({
  result: consumeResetResultSchema,
  account: accountViewSchema,
});

/** Inference availability of one configured OAuth credential, for account cards. */
export const accountHealthSchema = z.object({
  model_cooldowns: z
    .array(
      z.object({
        model: z.string(),
        until: z.number().nullable(),
        reason: z.enum(["quota", "unavailable"]),
      }),
    )
    .optional(),
  credential_id: identifierSchema,
  account_ref: z.uuid(),
  available: z.boolean(),
  cooling_until: z.number().nullable(),
  cooldown_reason: z.enum(HealthCooldownReason).nullable(),
  quota_blocks: z
    .array(
      z.object({ model: z.string().nullable(), until: z.number().nullable() }),
    )
    .optional(),
});
export type AccountHealth = z.output<typeof accountHealthSchema>;

export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "oauth_error",
  ) {
    super(message);
  }
}
export type AccountReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status: number; code: string };
export async function accountReply<T extends z.ZodType>(
  reply: Promise<AccountReply>,
  schema: T,
): Promise<z.output<T>> {
  const result = await reply;
  if (!result.ok)
    throw new OAuthError(result.error, result.status, result.code);
  return schema.parse(result.data);
}
