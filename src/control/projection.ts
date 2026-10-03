import { emptyEntities } from "./entities.ts";
import { z } from "zod";
import type { GatewayConfig } from "../config/types.ts";
import type { EntityRows, ModelRouteEntity } from "./entities.ts";

type NamedEntity =
  | EntityRows["providers"][number]
  | EntityRows["clients"][number]
  | EntityRows["proxy_groups"][number]
  | EntityRows["provider_credentials"][number]
  | EntityRows["proxy_nodes"][number];
const object = z.record(z.string(), z.unknown());
const list = z.array(object);

/** Assign identities at the trusted boundary, never from a display name. */
export function assignIdentities(value: unknown, rows: EntityRows): unknown {
  const input = object.parse(structuredClone(value));
  const map = (
    items: Record<string, unknown>[],
    table: NamedEntity[],
    parentKey?: "provider_id" | "group_id",
    parent?: string,
  ) => {
    const ids = new Map<string, string>();
    for (const item of items) {
      const ref = typeof item.id === "string" ? item.id : crypto.randomUUID();
      if (ids.has(ref)) throw new Error("Entity references must be unique");
      const previous = table.find((row) => row.id === ref);
      if (
        previous &&
        parentKey &&
        (parentKey === "provider_id" && "provider_id" in previous
          ? previous.provider_id
          : "group_id" in previous
            ? previous.group_id
            : undefined) !== parent
      )
        throw new Error("An entity cannot move to another parent");
      const id = previous ? String(previous.id) : crypto.randomUUID();
      const name = item.name ?? previous?.name;
      item.name = z.string().trim().min(1).max(256).parse(name);
      item.id = id;
      ids.set(ref, id);
    }
    return ids;
  };
  const groups = list.parse(input.proxy_groups ?? []);
  const groupIds = map(groups, rows.proxy_groups);
  for (const group of groups) {
    const nodes = list.parse(group.proxies);
    map(nodes, rows.proxy_nodes, "group_id", String(group.id));
    group.proxies = nodes;
  }
  const providers = list.parse(input.providers);
  const providerIds = map(providers, rows.providers);
  const proxy = (item: Record<string, unknown>) => {
    if (typeof item.proxy_group === "string")
      item.proxy_group = groupIds.get(item.proxy_group) ?? item.proxy_group;
  };
  const routes = (value: unknown) => {
    if (!value) return;
    for (const route of Object.values(object.parse(value))) {
      const r = object.parse(route);
      if (Array.isArray(r.providers))
        (route as Record<string, unknown>).providers = r.providers.map(
          (id) => providerIds.get(String(id)) ?? id,
        );
    }
  };
  for (const provider of providers) {
    const previous = rows.providers.find((row) => row.id === provider.id);
    if (previous && previous.type !== provider.type)
      throw new Error("A provider's type cannot be changed");
    proxy(provider);
    routes(provider.model_routes);
    const credentials = list.parse(provider.credentials);
    map(
      credentials,
      rows.provider_credentials,
      "provider_id",
      String(provider.id),
    );
    credentials.forEach(proxy);
    provider.credentials = credentials;
  }
  const clients = list.parse(input.api_keys);
  map(clients, rows.clients);
  for (const client of clients) {
    client.providers = z
      .array(z.string())
      .parse(client.providers)
      .map((id) => providerIds.get(id) ?? id);
    routes(client.model_routes);
  }
  routes(input.model_routes);
  if (input.model_prices)
    for (const price of list.parse(input.model_prices)) {
      price.provider_id =
        providerIds.get(String(price.provider_id)) ?? price.provider_id;
    }
  // z.object parsing copies objects, so explicitly replace the collections.
  input.proxy_groups = groups;
  input.providers = providers;
  input.api_keys = clients;
  if (input.model_prices)
    input.model_prices = list.parse(input.model_prices).map((price) => ({
      ...price,
      provider_id:
        providerIds.get(String(price.provider_id)) ?? price.provider_id,
    }));
  delete input.revision;
  return input;
}

export function projectConfiguration(
  config: GatewayConfig,
  previous: EntityRows,
  version: number,
  now: number,
): EntityRows {
  const rows = emptyEntities();

  const metadata = (
    id: string,
    table: readonly { id: string; created_at: number }[],
  ) => ({
    id,
    version,
    created_at: Number(table.find((row) => row.id === id)?.created_at ?? now),
    updated_at: now,
    deleted_at: null,
  });
  const ref = (value: string | undefined) =>
    value?.startsWith("__cody_secret:") ? value.slice(14) : null;
  for (const [position, group] of config.proxy_groups.entries()) {
    rows.proxy_groups.push({
      ...metadata(group.id, previous.proxy_groups),
      name: group.name!,
      strategy: group.strategy,
      position,
    });
    for (const [position, node] of group.proxies.entries())
      rows.proxy_nodes.push({
        ...metadata(node.id, previous.proxy_nodes),
        group_id: group.id,
        name: node.name!,
        url: node.url,
        username: node.username ?? null,
        secret_id: ref(node.password),
        priority: node.priority,
        disabled: node.disabled ? 1 : 0,
        position,
      });
  }
  const routeIds = new Set<string>();
  const addRoutes = (
    routes: GatewayConfig["model_routes"],
    scope: ModelRouteEntity["scope"],
    owner: string | null,
  ) => {
    for (const [position, [name, route]] of Object.entries(routes).entries()) {
      const old = previous.model_routes.find(
        (row) =>
          row.scope === scope &&
          (route.id ? row.id === route.id : row.name === name) &&
          (scope === "global" ||
            (scope === "client" ? row.client_id : row.provider_id) === owner),
      );
      const id = String(old?.id ?? crypto.randomUUID());
      if (routeIds.has(id))
        throw new Error("A route ID cannot be reused for multiple aliases");
      routeIds.add(id);
      rows.model_routes.push({
        ...metadata(id, previous.model_routes),
        scope,
        name,
        model: route.model,
        client_id: scope === "client" ? owner : null,
        provider_id: scope === "provider" ? owner : null,
        restrict_providers: route.providers !== undefined ? 1 : 0,
        position,
      });
      for (const [position, provider_id] of (route.providers ?? []).entries())
        rows.model_route_providers.push({
          route_id: id,
          provider_id,
          position,
          deleted_at: null,
        });
    }
  };
  for (const [position, provider] of config.providers.entries()) {
    const {
      id,
      name,
      credentials,
      models,
      model_settings,
      model_routes,
      proxy_group,
      priority,
      disabled,
      type,
      ...settings
    } = provider;
    rows.providers.push({
      ...metadata(id, previous.providers),
      name: name!,
      type,
      priority,
      disabled: disabled ? 1 : 0,
      position,
      proxy_group_id: proxy_group ?? null,
      settings_json: JSON.stringify(settings),
    });
    for (const [position, model] of models.entries()) {
      const old = previous.provider_models.find(
        (row) => row.provider_id === id && row.model === model,
      );
      rows.provider_models.push({
        ...metadata(
          String(old?.id ?? crypto.randomUUID()),
          previous.provider_models,
        ),
        provider_id: id,
        model,
        position,
        context_window: model_settings?.[model]?.context_window ?? null,
      });
    }
    for (const [position, credential] of credentials.entries())
      rows.provider_credentials.push({
        ...metadata(credential.id, previous.provider_credentials),
        provider_id: id,
        name: credential.name!,
        auth_type: credential.auth.type,
        secret_id:
          credential.auth.type === "api_key"
            ? ref(credential.auth.api_key)
            : null,
        account_ref:
          credential.auth.type === "oauth" ? credential.auth.account_ref : null,
        priority: credential.priority,
        disabled: credential.disabled ? 1 : 0,
        position,
        proxy_mode:
          credential.proxy_group === undefined
            ? "inherit"
            : credential.proxy_group === null
              ? "direct"
              : "group",
        proxy_group_id: credential.proxy_group ?? null,
      });
    addRoutes(model_routes ?? {}, "provider", id);
  }
  for (const [position, client] of config.api_keys.entries()) {
    rows.clients.push({
      ...metadata(client.id, previous.clients),
      name: client.name!,
      secret_id: z.uuid().parse(ref(client.api_key)),
      position,
    });
    for (const [position, provider_id] of client.providers.entries())
      rows.client_providers.push({
        client_id: client.id,
        provider_id,
        position,
        deleted_at: null,
      });
    addRoutes(client.model_routes ?? {}, "client", client.id);
  }
  addRoutes(config.model_routes, "global", null);
  for (const price of config.model_prices ?? []) {
    if (!price.pricing) continue;
    const model = rows.provider_models.find(
      (row) =>
        row.provider_id === price.provider_id && row.model === price.model,
    );
    if (!model)
      throw new Error("A price must reference an available provider model");
    const old = previous.model_prices.find(
      (row) => row.provider_model_id === model.id,
    );
    rows.model_prices.push({
      ...metadata(
        String(old?.id ?? crypto.randomUUID()),
        previous.model_prices,
      ),
      provider_model_id: model.id,
      pricing_json: JSON.stringify(price.pricing),
    });
  }
  const { web_search, reporting } = config;
  const search = { ...web_search };
  let searchSecret: string | null = null;
  if (search.mode !== "proxy") {
    searchSecret = ref(search.api_key);
    search.api_key = "";
  }
  rows.settings.push({
    name: "web_search",
    value_json: JSON.stringify(search),
    secret_id: searchSecret,
  });
  rows.settings.push({
    name: "reporting",
    value_json: JSON.stringify(
      reporting ?? { time_zone: "Asia/Shanghai", retention_days: 120 },
    ),
    secret_id: null,
  });
  return rows;
}
