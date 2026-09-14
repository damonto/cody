import type { z } from "zod";
import type {
  aiGatewayProviderSchema,
  clientSchema,
  configurationSchema,
  credentialSchema,
  retrySchema,
  routeSchema,
  searchSchema,
  providerSchema,
  socksProxySchema,
} from "./schema.ts";
export type SocksProxyConfig = z.output<typeof socksProxySchema>;
export type ProviderRetryConfig = z.output<typeof retrySchema>;
export type ProviderCredentialConfig = z.output<typeof credentialSchema>;

export type ProviderConfig = z.output<typeof providerSchema>;
export type AiGatewayProviderConfig = z.output<typeof aiGatewayProviderSchema>;
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
