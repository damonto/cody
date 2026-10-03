import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { read, rpc } from "./api";

export const resourceKeys = {
  providers: ["configuration", "providers"],
  clients: ["configuration", "clients"],
  proxies: ["configuration", "proxies"],
  prices: ["configuration", "prices"],
  routes: ["configuration", "routes"],
  reporting: ["configuration", "reporting"],
  search: ["configuration", "search"],
  native: ["configuration", "native"],
} as const;
function options<T>(
  key: readonly string[],
  fetch: (signal: AbortSignal) => Promise<T>,
) {
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => fetch(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}
export const providersOptions = options(resourceKeys.providers, (signal) =>
  read(rpc.providers.$get({}, { init: { signal } })),
);
export const clientsOptions = options(resourceKeys.clients, (signal) =>
  read(rpc.clients.$get({}, { init: { signal } })),
);
export const proxiesOptions = options(resourceKeys.proxies, (signal) =>
  read(rpc["proxy-groups"].$get({}, { init: { signal } })),
);
export const pricesOptions = options(resourceKeys.prices, (signal) =>
  read(rpc["model-prices"].$get({}, { init: { signal } })),
);
export const routesOptions = options(resourceKeys.routes, (signal) =>
  read(rpc["model-routes"].$get({}, { init: { signal } })),
);
export const reportingOptions = options(resourceKeys.reporting, (signal) =>
  read(rpc.settings.reporting.$get({}, { init: { signal } })),
);
export const searchOptions = options(resourceKeys.search, (signal) =>
  read(rpc.settings["web-search"].$get({}, { init: { signal } })),
);
export const nativeOptions = (
  type: "antigravity" | "codex" | "claude" | "xai",
) =>
  options([...resourceKeys.native, type], (signal) =>
    read(
      rpc["native-providers"][":type"].$get(
        { param: { type } },
        { init: { signal } },
      ),
    ),
  );
export function useReporting() {
  return useQuery(reportingOptions);
}

type ResourceResult = UseQueryResult<
  { version: number; item: unknown; etag: string },
  Error
>;
type ResourceData<T extends Record<string, ResourceResult>> = {
  version: number;
  tags: { [K in keyof T]: string };
} & { [K in keyof T]: NonNullable<T[K]["data"]>["item"] };
type Combined<T> = {
  isFetching: boolean;
  refetch: () => Promise<unknown>;
  refreshError: Error | null;
} & (
  | { isPending: true; error: null; data: undefined }
  | { isPending: false; error: Error; data: undefined }
  | { isPending: false; error: null; data: T }
);
/** Each feature names its read dependencies; an editor freezes only this resource view. */
function combine<T extends Record<string, ResourceResult>>(
  queries: T,
): Combined<ResourceData<T>> {
  const results = Object.values(queries);
  const error = results.find((query) => query.error)?.error ?? null;
  const state = {
    refreshError: results.every((query) => query.data) ? error : null,
    isFetching: results.some((query) => query.isFetching),
    refetch: () => Promise.all(results.map((query) => query.refetch())),
  };
  if (error && results.some((query) => !query.data))
    return { ...state, isPending: false, error, data: undefined };
  if (results.some((query) => !query.data))
    return { ...state, isPending: true, error: null, data: undefined };
  // The oldest read fences edits if independently fetched resources straddle an external save.
  const version = Math.min(...results.map((query) => query.data!.version));
  const data = {
    version,
    tags: Object.fromEntries(
      Object.entries(queries).map(([name, query]) => [name, query.data!.etag]),
    ),
    ...Object.fromEntries(
      Object.entries(queries).map(([name, query]) => [name, query.data!.item]),
    ),
  } as ResourceData<T>;
  return { ...state, isPending: false, error: null, data };
}
export function useProviderResources() {
  return combine({
    providers: useQuery(providersOptions),
    groups: useQuery(proxiesOptions),
    clients: useQuery(clientsOptions),
  });
}
export type ProviderResources = NonNullable<
  ReturnType<typeof useProviderResources>["data"]
>;
export function useClientResources() {
  return combine({
    clients: useQuery(clientsOptions),
    providers: useQuery(providersOptions),
  });
}
export type ClientResources = NonNullable<
  ReturnType<typeof useClientResources>["data"]
>;
export function useProxyResources() {
  return combine({
    groups: useQuery(proxiesOptions),
    providers: useQuery(providersOptions),
    reporting: useQuery(reportingOptions),
  });
}
export type ProxyResources = NonNullable<
  ReturnType<typeof useProxyResources>["data"]
>;
export function useRoutingResources() {
  return combine({
    providers: useQuery(providersOptions),
    clients: useQuery(clientsOptions),
    routes: useQuery(routesOptions),
  });
}
export type RoutingResources = NonNullable<
  ReturnType<typeof useRoutingResources>["data"]
>;
export function usePricingResources() {
  return combine({
    providers: useQuery(providersOptions),
    prices: useQuery(pricesOptions),
    reporting: useQuery(reportingOptions),
  });
}
export type PricingResources = NonNullable<
  ReturnType<typeof usePricingResources>["data"]
>;
export function useSettingsResources() {
  return combine({
    reporting: useQuery(reportingOptions),
    search: useQuery(searchOptions),
  });
}
export type SettingsResources = NonNullable<
  ReturnType<typeof useSettingsResources>["data"]
>;
export function useNativeResources(type: Parameters<typeof nativeOptions>[0]) {
  return combine({
    provider: useQuery(nativeOptions(type)),
    groups: useQuery(proxiesOptions),
  });
}
export type NativeResources = NonNullable<
  ReturnType<typeof useNativeResources>["data"]
>;
