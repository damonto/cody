import { ProviderType } from "../../config/values.ts";
import { OAuthFlow } from "./values.ts";

import { z } from "zod";
import {
  connectionSchema,
  xaiLimitSchema,
  quotaGroupSchema,
  quotaSnapshotSchema,
  oauthProviderTypeSchema,
  proxyConfigurationSchema,
} from "./schema.ts";

const sessionOwner = {
  actor: z.string().min(1),
  session_id: z.uuid(),
};

/** Required fields are checked both at RPC call sites and at the runtime boundary. */
export const accountCommandSchema = z.discriminatedUnion("action", [
  xaiLimitSchema.extend({
    action: z.literal("xai_limit"),
    generation: z.number(),
  }),
  z.strictObject({
    action: z.literal("xai_auth_invalid"),
    generation: z.number(),
    token: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("claude_usage"),
    extra_usage_disabled_reason: z.string().nullable().optional(),
    limits: quotaSnapshotSchema.shape.claude_limits,
    generation: z.number(),
    groups: z.array(quotaGroupSchema),
  }),
  z.strictObject({
    action: z.literal("claude_limit"),
    generation: z.number(),
    model: z.string().nullable(),
    until: z.number(),
    additional_limits: z
      .array(z.object({ model: z.string().nullable(), until: z.number() }))
      .optional(),
  }),
  z.strictObject({
    action: z.literal("start"),
    account_ref: z.uuid(),
    actor: sessionOwner.actor,
    connection: connectionSchema,
    provider_type: oauthProviderTypeSchema.default(ProviderType.Antigravity),
    flow: z.enum(OAuthFlow).default(OAuthFlow.Pkce),
  }),
  z.strictObject({
    action: z.enum(["session", "cancel", "retry"]),
    ...sessionOwner,
  }),
  z.strictObject({
    action: z.literal("complete"),
    ...sessionOwner,
    redirect_url: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    action: z.literal("resolve"),
    connection: connectionSchema,
    proxy_configuration: proxyConfigurationSchema,
  }),
  z.strictObject({
    action: z.enum([
      "view",
      "readiness",
      "models",
      "disconnect",
      "reset_credits",
      "retry_project",
    ]),
  }),
  z.strictObject({
    action: z.literal("consume_reset"),
    redeem_request_id: z.uuid(),
    credit_id: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({
    action: z.literal("quota"),
    force: z.boolean().default(false),
  }),
]);

export type AccountCommand = z.input<typeof accountCommandSchema>;
