import { z } from "zod";
import {
  clientSchema,
  configurationSchema,
  providerSchema,
  proxyGroupSchema,
  searchSchema,
} from "../config/schema.ts";
import { modelPriceSchema, reportingSchema } from "../billing/schema.ts";
import { DEFAULT_REPORTING } from "../billing/config.ts";
import type { GatewayConfig } from "../config/types.ts";
import type { EntityRows, ModelRouteEntity } from "./entities.ts";
import { secretReference } from "./secrets.ts";

const objectSchema = z.record(z.string(), z.unknown());
export const live = <T extends { deleted_at: number | null }>(
  rows: readonly T[],
) => rows.filter((row) => row.deleted_at === null);
export const ordered = <
  T extends { deleted_at: number | null; position: number },
>(
  rows: readonly T[],
) => live(rows).sort((a, b) => a.position - b.position);
export function routesFromEntities(
  rows: Pick<EntityRows, "model_routes" | "model_route_providers">,
  scope: ModelRouteEntity["scope"],
  owner?: string,
): GatewayConfig["model_routes"] {
  return Object.fromEntries(
    ordered(rows.model_routes)
      .filter(
        (row) =>
          row.scope === scope &&
          (scope === "global" ||
            (scope === "client" ? row.client_id : row.provider_id) === owner),
      )
      .map((row) => [
        row.name,
        {
          id: row.id,
          model: row.model,
          ...(row.restrict_providers
            ? {
                providers: ordered(rows.model_route_providers)
                  .filter((target) => target.route_id === row.id)
                  .map((target) => target.provider_id),
              }
            : {}),
        },
      ]),
  );
}
export function groupsFromEntities(
  rows: Pick<EntityRows, "proxy_groups" | "proxy_nodes">,
) {
  return ordered(rows.proxy_groups).map((group) =>
    proxyGroupSchema.parse({
      id: group.id,
      name: group.name,
      strategy: group.strategy,
      proxies: ordered(rows.proxy_nodes)
        .filter((node) => node.group_id === group.id)
        .map((node) => ({
          id: node.id,
          name: node.name,
          url: node.url,
          ...(node.username === null ? {} : { username: node.username }),
          ...(node.secret_id === null
            ? {}
            : { password: secretReference(node.secret_id) }),
          priority: node.priority,
          disabled: !!node.disabled,
        })),
    }),
  );
}
export function providersFromEntities(
  rows: Pick<
    EntityRows,
    | "providers"
    | "provider_credentials"
    | "provider_models"
    | "model_routes"
    | "model_route_providers"
  >,
) {
  return ordered(rows.providers).map((provider) =>
    providerSchema.parse({
      ...objectSchema.parse(JSON.parse(provider.settings_json)),
      id: provider.id,
      name: provider.name,
      type: provider.type,
      priority: provider.priority,
      disabled: !!provider.disabled,
      ...(provider.proxy_group_id === null
        ? {}
        : { proxy_group: provider.proxy_group_id }),
      models: ordered(rows.provider_models)
        .filter((model) => model.provider_id === provider.id)
        .map((model) => model.model),
      model_settings: Object.fromEntries(
        ordered(rows.provider_models)
          .filter((model) => model.provider_id === provider.id)
          .map((model) => [
            model.model,
            {
              id: model.id,
              ...(model.context_window === null
                ? {}
                : { context_window: model.context_window }),
            },
          ]),
      ),
      model_routes: routesFromEntities(rows, "provider", provider.id),
      credentials: ordered(rows.provider_credentials)
        .filter((credential) => credential.provider_id === provider.id)
        .map((credential) => ({
          id: credential.id,
          name: credential.name,
          priority: credential.priority,
          disabled: !!credential.disabled,
          auth:
            credential.auth_type === "oauth"
              ? { type: "oauth", account_ref: credential.account_ref }
              : {
                  type: "api_key",
                  api_key: secretReference(
                    z.uuid().parse(credential.secret_id),
                  ),
                },
          ...(credential.proxy_mode === "inherit"
            ? {}
            : { proxy_group: credential.proxy_group_id }),
        })),
    }),
  );
}
export function clientsFromEntities(
  rows: Pick<
    EntityRows,
    "clients" | "client_providers" | "model_routes" | "model_route_providers"
  >,
) {
  return ordered(rows.clients).map((client) =>
    clientSchema.parse({
      id: client.id,
      name: client.name,
      api_key: secretReference(client.secret_id),
      providers: ordered(rows.client_providers)
        .filter((item) => item.client_id === client.id)
        .map((item) => item.provider_id),
      model_routes: routesFromEntities(rows, "client", client.id),
    }),
  );
}
export function pricesFromEntities(
  rows: Pick<EntityRows, "model_prices" | "provider_models">,
) {
  return live(rows.model_prices)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((price) => {
      const model = live(rows.provider_models).find(
        (row) => row.id === price.provider_model_id,
      );
      if (!model) throw new Error("Price references a missing provider model");
      return modelPriceSchema.parse({
        id: price.id,
        provider_id: model.provider_id,
        model: model.model,
        pricing: JSON.parse(price.pricing_json),
      });
    });
}
export function reportingFromEntities(rows: Pick<EntityRows, "settings">) {
  const setting = rows.settings.find((row) => row.name === "reporting");
  return reportingSchema.parse(
    setting ? JSON.parse(setting.value_json) : DEFAULT_REPORTING,
  );
}
export function searchFromEntities(rows: Pick<EntityRows, "settings">) {
  const setting = rows.settings.find((row) => row.name === "web_search");
  const value = setting
    ? objectSchema.parse(JSON.parse(setting.value_json))
    : { mode: "proxy" };
  if (setting?.secret_id) value.api_key = secretReference(setting.secret_id);
  return searchSchema.parse(value);
}
/** One-way compilation; resource services edit entities, never this document. */
export function configurationFromEntities(rows: EntityRows): GatewayConfig {
  return configurationSchema.parse({
    proxy_groups: groupsFromEntities(rows),
    providers: providersFromEntities(rows),
    api_keys: clientsFromEntities(rows),
    model_routes: routesFromEntities(rows, "global"),
    model_prices: pricesFromEntities(rows),
    reporting: reportingFromEntities(rows),
    web_search: searchFromEntities(rows),
  });
}

/** Allocate immutable price version identities once for this configuration commit. */
export function compileSnapshot(
  rows: EntityRows,
  revision: number,
): GatewayConfig {
  const config = configurationFromEntities(rows);
  return {
    ...config,
    revision,
    model_prices: config.model_prices?.map((price) => ({
      ...price,
      version_id: crypto.randomUUID(),
    })),
  };
}
