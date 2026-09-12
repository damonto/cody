import type { z } from "zod";
import type {
  clientSchema,
  configurationSchema,
  credentialSchema,
  draftConfigurationSchema,
  retrySchema,
  routeSchema,
  searchSchema,
  serviceRouteSchema,
  serviceSchema,
} from "./schema.ts";
export type ServiceRetryConfig = z.output<typeof retrySchema>;
export type ServiceApiKeyConfig = z.output<typeof credentialSchema>;
export type ServiceModelRouteConfig = z.output<typeof serviceRouteSchema>;
export type ServiceConfig = z.output<typeof serviceSchema>;
export type ClientApiKeyConfig = z.output<typeof clientSchema>;
export type ModelRouteConfig = z.output<typeof routeSchema>;
export type WebSearchConfig = z.output<typeof searchSchema>;
export type WebSearchMode = WebSearchConfig["mode"];
export type WebSearchProviderConfig = Exclude<
  WebSearchConfig,
  { mode: "proxy" }
>;
export type GatewayConfig = z.output<typeof configurationSchema>;
export type DraftConfig = z.output<typeof draftConfigurationSchema>;
export interface ServiceHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
