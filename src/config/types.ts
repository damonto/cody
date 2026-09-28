import { type HealthCooldownReason } from "../gateway/health/values.ts";

import type { z } from "zod";
import type {
  aiGatewayProviderSchema,
  antigravityProviderSchema,
  clientSchema,
  codexProviderSchema,
  claudeProviderSchema,
  configurationSchema,
  credentialSchema,
  oauthCredentialSchema,
  providerSchema,
  proxyGroupSchema,
  proxyNodeSchema,
  retrySchema,
  routeSchema,
  searchSchema,
  socksProxySchema,
} from "./schema.ts";
export type SocksProxyConfig = z.output<typeof socksProxySchema>;
export type ProxyNodeConfig = z.output<typeof proxyNodeSchema>;
export type ProxyGroupConfig = z.output<typeof proxyGroupSchema>;
export type { ProxyStrategy } from "./values.ts";
export type ProviderRetryConfig = z.output<typeof retrySchema>;
export type ApiKeyCredentialConfig = z.output<typeof credentialSchema>;
export type OAuthCredentialConfig = z.output<typeof oauthCredentialSchema>;
export type ProviderCredentialConfig =
  ApiKeyCredentialConfig | OAuthCredentialConfig;

export type ProviderConfig = z.output<typeof providerSchema>;
export type AiGatewayProviderConfig = z.output<typeof aiGatewayProviderSchema>;
export type AntigravityProviderConfig = z.output<
  typeof antigravityProviderSchema
>;
export type ClaudeProviderConfig = z.output<typeof claudeProviderSchema>;
export type CodexProviderConfig = z.output<typeof codexProviderSchema>;
export type { CodexAccountSelection } from "./values.ts";
/** Native providers whose credentials are OAuth accounts. */
export type OAuthProviderConfig =
  AntigravityProviderConfig | CodexProviderConfig | ClaudeProviderConfig;
export type { ProviderType } from "./values.ts";
export type CredentialAuth = ProviderCredentialConfig["auth"];
export type ClientApiKeyConfig = z.output<typeof clientSchema>;
export type ModelRouteConfig = z.output<typeof routeSchema>;
type WebSearchConfig = z.output<typeof searchSchema>;
export type WebSearchMode = WebSearchConfig["mode"];
export type WebSearchProviderConfig = Exclude<
  WebSearchConfig,
  { mode: "proxy" }
>;
export type GatewayConfig = z.output<typeof configurationSchema>;

/** Why a cooldown is active when it is not the ordinary failure streak. */
export type { HealthCooldownReason } from "../gateway/health/values.ts";

export interface ProviderHealthSnapshot {
  failures: number;
  cooling_until: number | null;
  reason?: HealthCooldownReason;
}
