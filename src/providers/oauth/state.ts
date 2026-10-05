import { xaiDeviceSchema } from "../xai/api.ts";

import {
  OAuthAccountViewStatus,
  OAuthFlow,
  OAuthSessionStatus,
  OAuthAccountStatus,
} from "./values.ts";
import { ProviderType } from "../../config/values.ts";

import { z } from "zod";

import { projectInitializationSchema } from "../antigravity/initialization.ts";

import {
  OAuthError,
  accountViewSchema,
  connectionSchema,
  identitySchema,
  oauthProviderTypeSchema,
  quotaSnapshotSchema,
  sessionStatusSchema,
  tokenSchema,
} from "./schema.ts";

const sessionSchema = z.object({
  id: z.uuid(),
  actor: z.string(),
  status: sessionStatusSchema,
  state: z.string(),
  verifier: z.string(),
  challenge: z.string(),
  expires_at: z.number(),
  connection: connectionSchema,
  error: z.string().nullable(),
  tokens: tokenSchema.nullable(),
  identity: identitySchema.nullable(),
  next_at: z.number(),
  flow: z.enum(OAuthFlow).default(OAuthFlow.Pkce),
  // Device authorization polls the issuer from the alarm until approval.
  xai_device: xaiDeviceSchema.optional(),
  device_auth_id: z.string().nullable().default(null),
  user_code: z.string().nullable().default(null),
  poll_interval_ms: z.number().default(5000),
});
const storedBase = z.object({
  account_ref: z.uuid(),
  provider_id: z.string(),
  provider_type: oauthProviderTypeSchema.default(ProviderType.Antigravity),
  generation: z.number(),
  status: z.enum(OAuthAccountStatus),
  connection: connectionSchema,
  tokens: tokenSchema.nullable(),
  identity: identitySchema.nullable(),
  project_id: z.string().nullable(),
  antigravity_initialization: projectInitializationSchema.nullable().optional(),
  codex: accountViewSchema.shape.codex,
  claude: accountViewSchema.shape.claude,
  xai: accountViewSchema.shape.xai,
  claude_quota_revision: z.number().default(0),
  error: z.string().nullable(),
  session: sessionSchema.nullable(),
  models: accountViewSchema.shape.models,
  models_updated_at: z.number().nullable(),
  models_error: z.string().nullable(),
  models_verification: accountViewSchema.shape.models_verification,
  quota: quotaSnapshotSchema,
});
export const storedSchema = z.discriminatedUnion("provider_type", [
  storedBase.extend({
    provider_type: z
      .literal(ProviderType.Antigravity)
      .default(ProviderType.Antigravity),
    codex: z.null().default(null),
    claude: z.null().optional(),
    xai: z.null().optional(),
  }),
  storedBase.extend({
    provider_type: z.literal(ProviderType.Codex),
    project_id: z.null(),
    antigravity_initialization: z.null().optional(),
    claude: z.null().optional(),
    xai: z.null().optional(),
  }),
  storedBase.extend({
    provider_type: z.literal(ProviderType.Claude),
    project_id: z.null(),
    antigravity_initialization: z.null().optional(),
    codex: z.null().default(null),
    xai: z.null().optional(),
  }),
  storedBase.extend({
    provider_type: z.literal(ProviderType.Xai),
    project_id: z.null(),
    antigravity_initialization: z.null().optional(),
    codex: z.null().default(null),
    claude: z.null().optional(),
  }),
]);
export type Stored = z.output<typeof storedSchema>;
export type Session = z.output<typeof sessionSchema>;
export const terminalSessionStatuses: ReadonlySet<OAuthSessionStatus> = new Set(
  [
    OAuthSessionStatus.Complete,
    OAuthSessionStatus.Cancelled,
    OAuthSessionStatus.Expired,
  ],
);

export const emptyQuota = (): Stored["quota"] => ({
  groups: [],
  subscription: null,
  updated_at: null,
  last_error: null,
  stale: true,
});
export const devicePending = (session: Session): boolean =>
  session.flow === OAuthFlow.Device &&
  session.status === OAuthSessionStatus.Pending;
export function nextAccountAlarm(account: Stored): number | null {
  const times: number[] = [];
  const session = account.session;
  if (session && !terminalSessionStatuses.has(session.status)) {
    times.push(session.expires_at);
    if (
      session.status === OAuthSessionStatus.Initializing ||
      devicePending(session)
    )
      times.push(session.next_at);
  }
  const project = account.antigravity_initialization;
  if (project && project.error === null)
    times.push(project.next_at, project.deadline);
  return times.length ? Math.min(...times) : null;
}
export function accountViewStatus(account: Stored): OAuthAccountViewStatus {
  if (account.status === OAuthAccountStatus.Ready) return account.status;
  if (account.antigravity_initialization)
    return OAuthAccountViewStatus.Initializing;
  if (account.status !== OAuthAccountStatus.Disconnected) return account.status;
  switch (account.session?.status) {
    case OAuthSessionStatus.Initializing:
      return OAuthAccountViewStatus.Initializing;
    case OAuthSessionStatus.Pending:
    case OAuthSessionStatus.Exchanging:
      return OAuthAccountViewStatus.Authorizing;
    default:
      return account.status;
  }
}
export function safeError(error: unknown): string {
  return error instanceof OAuthError
    ? error.message
    : "The account operation failed; check the selected proxy and try again";
}
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
