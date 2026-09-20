import { z } from "zod";
import { identifierSchema, proxyGroupSchema } from "../../config/schema.ts";

export const connectionSchema = z.object({
  provider_id: identifierSchema,
  credential_id: identifierSchema,
  provider_proxy_group: identifierSchema.nullable().optional(),
  credential_proxy_group: identifierSchema.nullable().optional(),
});
export type ProviderConnection = z.output<typeof connectionSchema>;
export const proxyConfigurationSchema = z.object({
  proxy_groups: z.array(proxyGroupSchema).default([]),
  revision: z.number().int().nonnegative().optional(),
});
export type ProxyConfiguration = z.output<typeof proxyConfigurationSchema>;
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_at: z.number(),
});
export const identitySchema = z.object({
  id: z.string().min(1),
  email: z.email(),
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
});
export const quotaGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  buckets: z.array(quotaBucketSchema),
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
});
export const quotaSnapshotSchema = z.object({
  groups: z.array(quotaGroupSchema),
  subscription: subscriptionSchema.nullable(),
  updated_at: z.number().nullable(),
  last_error: z.string().nullable(),
  stale: z.boolean(),
});
export type QuotaSnapshot = z.output<typeof quotaSnapshotSchema>;
export const accountViewSchema = z.object({
  account_ref: z.uuid(),
  provider_id: identifierSchema,
  status: z.enum([
    "disconnected",
    "authorizing",
    "initializing",
    "ready",
    "needs_reauthorization",
  ]),
  email: z.string().nullable(),
  project_id: z.string().nullable(),
  expires_at: z.number().nullable(),
  error: z.string().nullable(),
  models: z.array(modelSchema),
  models_updated_at: z.number().nullable(),
  models_error: z.string().nullable(),
  quota: quotaSnapshotSchema,
});
export type AccountView = z.output<typeof accountViewSchema>;
export const sessionStatusSchema = z.enum([
  "pending",
  "exchanging",
  "initializing",
  "complete",
  "cancelled",
  "expired",
  "error",
]);
export const sessionViewSchema = z.object({
  id: z.string(),
  account_ref: z.uuid(),
  status: sessionStatusSchema,
  expires_at: z.number(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  can_retry: z.boolean(),
  account: accountViewSchema,
});
export type SessionView = z.output<typeof sessionViewSchema>;
export const resolvedOAuthSchema = z.object({
  token: z.string().min(1),
  project_id: z.string().min(1),
});

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
