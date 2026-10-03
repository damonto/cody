import type {
  GatewayConfig,
  ModelRouteConfig,
  ProviderConfig,
} from "../../../../src/config/types";

// The scope picker stores a string key; parse it once instead of slicing
// prefixes by hand at every call site.
export type RouteScope =
  | { kind: "global" }
  | { kind: "provider"; id: string }
  | { kind: "client"; id: string };

export const GLOBAL_SCOPE_KEY = "global";
const PROVIDER_PREFIX = "provider:";
const CLIENT_PREFIX = "client:";

export function scopeKey(scope: RouteScope): string {
  if (scope.kind === "provider") return `${PROVIDER_PREFIX}${scope.id}`;
  if (scope.kind === "client") return `${CLIENT_PREFIX}${scope.id}`;
  return GLOBAL_SCOPE_KEY;
}

export function parseScope(key: string): RouteScope {
  if (key.startsWith(PROVIDER_PREFIX))
    return { kind: "provider", id: key.slice(PROVIDER_PREFIX.length) };
  if (key.startsWith(CLIENT_PREFIX))
    return { kind: "client", id: key.slice(CLIENT_PREFIX.length) };
  return { kind: "global" };
}

// Providers whose declared models a route in this scope may target.
export function scopeProviders(
  config: {
    providers: GatewayConfig["providers"];
    clients: GatewayConfig["api_keys"];
    routes: GatewayConfig["model_routes"];
  },
  scope: RouteScope,
): ProviderConfig[] {
  if (scope.kind === "provider")
    return config.providers.filter((provider) => provider.id === scope.id);
  if (scope.kind === "client") {
    const client = config.clients.find((entry) => entry.id === scope.id);
    return config.providers.filter((provider) =>
      client?.providers.includes(provider.id),
    );
  }
  return config.providers;
}

export function routesFor(
  config: {
    providers: GatewayConfig["providers"];
    clients: GatewayConfig["api_keys"];
    routes: GatewayConfig["model_routes"];
  },
  scope: RouteScope,
): Record<string, ModelRouteConfig> {
  if (scope.kind === "provider")
    return (
      config.providers.find((provider) => provider.id === scope.id)
        ?.model_routes ?? {}
    );
  if (scope.kind === "client")
    return (
      config.clients.find((client) => client.id === scope.id)?.model_routes ??
      {}
    );
  return config.routes;
}
