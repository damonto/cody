import { z } from "zod";

// SQL boundary schemas: malformed persisted data fails closed before reaching services.
const timestamp = z.number().int().nonnegative();
const flag = z.union([z.literal(0), z.literal(1)]);
const metadata = z.object({
  id: z.uuid(),
  version: z.number().int().nonnegative(),
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: timestamp.nullable(),
});
const ordered = metadata.extend({ position: z.number().int().nonnegative() });
const relation = z.object({
  position: z.number().int().nonnegative(),
  deleted_at: timestamp.nullable(),
});
export const entitySchemas = {
  proxy_groups: ordered.extend({
    name: z.string(),
    strategy: z.enum(["random", "sticky", "priority"]),
  }),
  providers: ordered.extend({
    name: z.string(),
    type: z.enum(["ai_gateway", "antigravity", "codex", "claude", "xai"]),
    priority: z.number().int(),
    disabled: flag,
    proxy_group_id: z.uuid().nullable(),
    settings_json: z.string(),
  }),
  provider_credentials: ordered.extend({
    provider_id: z.uuid(),
    name: z.string(),
    auth_type: z.enum(["api_key", "oauth"]),
    secret_id: z.uuid().nullable(),
    account_ref: z.uuid().nullable(),
    priority: z.number().int(),
    disabled: flag,
    proxy_mode: z.enum(["inherit", "direct", "group"]),
    proxy_group_id: z.uuid().nullable(),
  }),
  clients: ordered.extend({ name: z.string(), secret_id: z.uuid() }),
  client_providers: relation.extend({
    client_id: z.uuid(),
    provider_id: z.uuid(),
  }),
  proxy_nodes: ordered.extend({
    group_id: z.uuid(),
    name: z.string(),
    url: z.string(),
    username: z.string().nullable(),
    secret_id: z.uuid().nullable(),
    priority: z.number().int(),
    disabled: flag,
  }),
  provider_models: ordered.extend({
    provider_id: z.uuid(),
    model: z.string(),
    context_window: z.number().int().positive().nullable(),
  }),
  model_routes: ordered.extend({
    scope: z.enum(["global", "client", "provider"]),
    client_id: z.uuid().nullable(),
    provider_id: z.uuid().nullable(),
    name: z.string(),
    model: z.string(),
    restrict_providers: flag,
  }),
  model_route_providers: relation.extend({
    route_id: z.uuid(),
    provider_id: z.uuid(),
  }),
  model_prices: metadata.extend({
    provider_model_id: z.uuid(),
    pricing_json: z.string(),
  }),
  settings: z.object({
    name: z.enum(["reporting", "web_search"]),
    value_json: z.string(),
    secret_id: z.uuid().nullable(),
  }),
};
export const entityTables = [
  "proxy_groups",
  "providers",
  "provider_credentials",
  "clients",
  "client_providers",
  "proxy_nodes",
  "provider_models",
  "model_routes",
  "model_route_providers",
  "model_prices",
  "settings",
] as const;
export type EntityTable = keyof typeof entitySchemas;
export type Entity<T extends EntityTable> = z.infer<(typeof entitySchemas)[T]>;
export type EntityRows = { [T in EntityTable]: Entity<T>[] };
export type ProviderEntity = Entity<"providers">;
export type CredentialEntity = Entity<"provider_credentials">;
export type ClientEntity = Entity<"clients">;
export type ProxyGroupEntity = Entity<"proxy_groups">;
export type ProxyNodeEntity = Entity<"proxy_nodes">;
export type ProviderModelEntity = Entity<"provider_models">;
export type ModelRouteEntity = Entity<"model_routes">;
export type ModelPriceEntity = Entity<"model_prices">;
export interface SecretVersion {
  id: string;
  owner_id: string;
  field: string;
  ciphertext: string;
  created_at: number;
  revoked_at: number | null;
}
export function emptyEntities(): EntityRows {
  return {
    proxy_groups: [],
    providers: [],
    provider_credentials: [],
    clients: [],
    client_providers: [],
    proxy_nodes: [],
    provider_models: [],
    model_routes: [],
    model_route_providers: [],
    model_prices: [],
    settings: [],
  };
}
