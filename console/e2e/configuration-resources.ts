import { z } from "zod";
import {
  maskedConfigurationSchema,
  providerSchema,
} from "../../src/config/schema";
import {
  clientInputSchema,
  providerInputSchema,
  nativeSettingsSchema,
  credentialInputSchema,
  groupInputSchema,
  nodeInputSchema,
} from "../../src/admin/resource-schema";
import type {
  GatewayConfig,
  ProviderCredentialConfig,
} from "../../src/config/types";

/** Browser fixture for the resource API. SQL behavior is exercised by Worker integration tests. */
export function resourceRequest(
  current: GatewayConfig,
  pathname: string,
  method: string,
  body: Record<string, unknown>,
) {
  const config = structuredClone(current);
  const parts = pathname
    .replace("/console/api/", "")
    .split("/")
    .map(decodeURIComponent);
  const [resource, id, child, childId] = parts;
  const object = z.record(z.string(), z.unknown());
  let item: unknown = null;
  const update = <T extends { id: string }>(items: T[], id: string, value: T) =>
    items.map((item) => (item.id === id ? value : item));
  if (resource === "native-providers") {
    const settings = nativeSettingsSchema.parse(body.settings);
    const old = config.providers.find((item) => item.type === id);
    const provider = providerSchema.parse({
      ...settings,
      id: old?.id ?? crypto.randomUUID(),
      credentials: old?.credentials ?? [],
    });
    config.providers = old
      ? update(config.providers, old.id, provider)
      : [...config.providers, provider];
    item = provider;
  } else if (resource === "providers" && child === "credentials") {
    const provider = config.providers.find((item) => item.id === id)!;
    if (childId === "order") {
      const ids = z.array(z.string()).parse(body.ids);
      const byId = new Map(provider.credentials.map((item) => [item.id, item]));
      const credentials = ids.map((id) => byId.get(id)!);
      config.providers = update(
        config.providers,
        id,
        providerSchema.parse({ ...provider, credentials }),
      );
      item = credentials;
    } else {
      const credentials =
        method === "DELETE"
          ? provider.credentials.filter((item) => item.id !== childId)
          : (() => {
              const credential = {
                ...credentialInputSchema.parse(body.credential),
                id: childId ?? crypto.randomUUID(),
              };
              item = credential;
              return childId
                ? update<ProviderCredentialConfig>(
                    provider.credentials,
                    childId,
                    credential,
                  )
                : [...provider.credentials, credential];
            })();
      config.providers = update(
        config.providers,
        id,
        providerSchema.parse({
          ...provider,
          credentials,
          disabled: provider.disabled || !credentials.length,
        }),
      );
    }
  } else if (resource === "providers" && child === "models") {
    const provider = config.providers.find((item) => item.id === id)!;
    const model = Object.entries(provider.model_settings ?? {}).find(
      ([, value]) => value.id === childId,
    )!;
    const settings = object.parse(body.settings);
    provider.model_settings![model[0]] = {
      id: childId,
      ...(typeof settings.context_window === "number"
        ? { context_window: settings.context_window }
        : {}),
    };
    item = provider.model_settings![model[0]];
  } else if (child === "model-routes" || resource === "model-routes") {
    const routes = maskedConfigurationSchema.parse({
      ...config,
      model_routes: body.routes,
    }).model_routes;
    if (resource === "providers")
      config.providers.find((item) => item.id === id)!.model_routes = routes;
    else if (resource === "clients")
      config.api_keys.find((item) => item.id === id)!.model_routes = routes;
    else config.model_routes = routes;
    item = routes;
  } else if (resource === "providers") {
    if (method === "DELETE")
      config.providers = config.providers.filter((item) => item.id !== id);
    else {
      const provider = {
        ...providerInputSchema.parse(body.provider),
        id: id ?? crypto.randomUUID(),
      };
      config.providers = id
        ? update(config.providers, id, provider)
        : [...config.providers, provider];
      item = provider;
    }
  } else if (resource === "clients") {
    if (method === "DELETE")
      config.api_keys = config.api_keys.filter((item) => item.id !== id);
    else {
      const client = {
        ...clientInputSchema.parse(body.client),
        id: id ?? crypto.randomUUID(),
      };
      config.api_keys = id
        ? update(config.api_keys, id, client)
        : [...config.api_keys, client];
      item = client;
    }
  } else if (resource === "proxy-groups" && child === "nodes") {
    const group = config.proxy_groups.find((item) => item.id === id)!;
    if (method === "DELETE")
      group.proxies = group.proxies.filter((item) => item.id !== childId);
    else {
      const node = {
        ...nodeInputSchema.parse(body.node),
        id: childId ?? crypto.randomUUID(),
      };
      group.proxies = childId
        ? update(group.proxies, childId, node)
        : [...group.proxies, node];
      item = node;
    }
  } else if (resource === "proxy-groups") {
    if (method === "DELETE")
      config.proxy_groups = config.proxy_groups.filter(
        (item) => item.id !== id,
      );
    else {
      const group = {
        ...groupInputSchema.parse(body.group),
        id: id ?? crypto.randomUUID(),
      };
      config.proxy_groups = id
        ? update(config.proxy_groups, id, group)
        : [...config.proxy_groups, group];
      item = group;
    }
  } else if (resource === "settings") {
    const next = maskedConfigurationSchema.parse({
      ...config,
      ...(id === "reporting"
        ? { reporting: body.reporting }
        : { web_search: body.web_search }),
    });
    if (id === "reporting") {
      config.reporting = next.reporting;
      item = next.reporting;
    } else {
      config.web_search = next.web_search;
      item = next.web_search;
    }
  } else if (resource === "model-prices") {
    const provider = config.providers.find((item) =>
      Object.values(item.model_settings ?? {}).some(
        (settings) => settings.id === id,
      ),
    )!;
    const model = Object.entries(provider.model_settings!).find(
      ([, settings]) => settings.id === id,
    )![0];
    config.model_prices = config.model_prices?.filter(
      (price) => price.provider_id !== provider.id || price.model !== model,
    );
    if (method !== "DELETE") {
      const parsed = maskedConfigurationSchema.parse({
        ...config,
        model_prices: [
          { provider_id: provider.id, model, pricing: body.pricing },
        ],
      });
      item = parsed.model_prices![0];
      config.model_prices = [
        ...(config.model_prices ?? []),
        parsed.model_prices![0],
      ];
    }
  } else throw new Error(`Unexpected resource request: ${method} ${pathname}`);
  config.model_prices = config.model_prices?.filter((price) =>
    config.providers.some(
      (item) =>
        item.id === price.provider_id && item.models.includes(price.model),
    ),
  );
  for (const provider of config.providers)
    for (const model of provider.models) {
      provider.model_settings ??= {};
      provider.model_settings[model] = {
        id: crypto.randomUUID(),
        ...provider.model_settings[model],
      };
    }
  return { config: maskedConfigurationSchema.parse(config), item };
}
