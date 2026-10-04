import { antigravityVariant } from "../../shared/antigravity-models.ts";
import type { GatewayConfig } from "../../config/types.ts";
import type { ModelRouteEntity, EntityRows } from "../entities.ts";
import type { ConfigurationUnitOfWork } from "../unit-of-work.ts";
import { ControlInputError, ControlNotFound, required } from "../errors.ts";
import { live } from "../compiler.ts";

export function put<T extends { id: string }>(rows: T[], row: T): void {
  const index = rows.findIndex((old) => old.id === row.id);
  if (index < 0) rows.push(row);
  else rows[index] = row;
}
export function reorder<
  T extends {
    id: string;
    position: number;
    deleted_at: number | null;
    version: number;
    updated_at: number;
  },
>(work: ConfigurationUnitOfWork, rows: T[], ids: string[]): void {
  const items = live(rows);
  const byId = new Map(items.map((item) => [item.id, item]));
  if (
    ids.length !== items.length ||
    new Set(ids).size !== items.length ||
    ids.some((id) => !byId.has(id))
  )
    throw new ControlInputError("Order must include every entity exactly once");
  ids.forEach((id, position) =>
    Object.assign(required(byId.get(id), "Entity"), {
      position,
      version: work.version,
      updated_at: work.now,
    }),
  );
}
export function replaceRoutes(
  work: ConfigurationUnitOfWork,
  scope: ModelRouteEntity["scope"],
  owner: string | null,
  routes: GatewayConfig["model_routes"],
) {
  const { rows } = work;
  const owned = (row: ModelRouteEntity) =>
    row.scope === scope &&
    (scope === "global" ||
      (scope === "client" ? row.client_id : row.provider_id) === owner);
  const previous = rows.model_routes.filter(owned);
  const previousIds = new Set(previous.map((row) => row.id));
  const used = new Set<string>();
  const next = Object.entries(routes).map(
    ([name, route], position): ModelRouteEntity => {
      const old = previous.find((row) =>
        route.id
          ? row.id === route.id
          : row.name === name && row.deleted_at === null,
      );
      if (
        route.id &&
        rows.model_routes.some((row) => row.id === route.id && !owned(row))
      )
        throw new ControlInputError("A route cannot move to another owner");
      const metadata = work.metadata(old);
      if (used.has(metadata.id))
        throw new ControlInputError(
          "A route ID cannot be reused for multiple aliases",
        );
      used.add(metadata.id);
      return {
        ...metadata,
        scope,
        client_id: scope === "client" ? owner : null,
        provider_id: scope === "provider" ? owner : null,
        name,
        model: route.model,
        restrict_providers: route.providers === undefined ? 0 : 1,
        position,
      };
    },
  );
  rows.model_routes = rows.model_routes.filter((row) => !owned(row));
  rows.model_routes.push(...next);
  rows.model_route_providers = rows.model_route_providers.filter(
    (row) => !previousIds.has(row.route_id),
  );
  for (const route of next)
    for (const [position, provider_id] of (
      routes[route.name].providers ?? []
    ).entries())
      rows.model_route_providers.push({
        route_id: route.id,
        provider_id,
        position,
        deleted_at: null,
      });
}
export function removeRoutes(
  work: ConfigurationUnitOfWork,
  scope: ModelRouteEntity["scope"],
  owner: string,
) {
  replaceRoutes(work, scope, owner, {});
}
export const providerFor = (config: GatewayConfig, id: string) =>
  required(
    config.providers.find((row) => row.id === id),
    "Provider",
  );
export const clientFor = (config: GatewayConfig, id: string) =>
  required(
    config.api_keys.find((row) => row.id === id),
    "Client",
  );
export const groupFor = (config: GatewayConfig, id: string) =>
  required(
    config.proxy_groups.find((row) => row.id === id),
    "Proxy group",
  );
export function modelFor(config: GatewayConfig, id: string) {
  for (const provider of config.providers) {
    const entry = Object.entries(provider.model_settings ?? {}).find(
      ([, settings]) => settings.id === id,
    );
    if (entry) return { provider, name: entry[0], settings: entry[1] };
  }
  throw new ControlNotFound("Provider model does not exist");
}

/** Resolve the complete family from authoritative entities within the fenced write. */
export function modelFamily(
  rows: Pick<EntityRows, "providers" | "provider_models">,
  modelId: string,
) {
  const anchor = required(
    live(rows.provider_models).find((row) => row.id === modelId),
    "Provider model",
  );
  const provider = required(
    live(rows.providers).find((row) => row.id === anchor.provider_id),
    "Provider",
  );
  const models = live(rows.provider_models).filter(
    (row) => row.provider_id === provider.id,
  );
  const variant = antigravityVariant(anchor.model);
  if (
    provider.type !== "antigravity" ||
    !variant ||
    models.some((row) => row.model === variant.family)
  )
    throw new ControlInputError(
      "The selected model does not belong to an Antigravity thinking family",
    );
  return models.filter(
    (row) => antigravityVariant(row.model)?.family === variant.family,
  );
}
