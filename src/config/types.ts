import type { z } from "zod";
import type {
  aiGatewayProviderSchema,
  antigravityProviderSchema,
  clientSchema,
  configurationSchema,
  credentialSchema,
  oauthCredentialSchema,
  providerSchema,
  proxyGroupSchema,
  proxyNodeSchema,
  proxyStrategySchema,
  retrySchema,
  routeSchema,
  searchSchema,
  socksProxySchema,
} from "./schema.ts";
export type SocksProxyConfig = z.output<typeof socksProxySchema>;
export type ProxyNodeConfig = z.output<typeof proxyNodeSchema>;
export type ProxyGroupConfig = z.output<typeof proxyGroupSchema>;
export type ProxyStrategy = z.output<typeof proxyStrategySchema>;
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
export type ProviderType = ProviderConfig["type"];
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

export interface ProviderHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
