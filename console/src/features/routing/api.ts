import { resourceKeys } from "@/lib/resources";
import type { ModelRouteConfig } from "../../../../src/config/types";
import type { RouteScope } from "./scope";
import { rpc, read } from "@/lib/api";
import { useConfigurationMutation } from "@/lib/configuration-mutation";
export function useSaveModelRoutes() {
  return useConfigurationMutation<{
    version: number;
    scope: RouteScope;
    routes: Record<string, ModelRouteConfig>;
  }>(
    (input) => {
      if (input.scope.kind === "provider")
        return [resourceKeys.providers, resourceKeys.native];
      if (input.scope.kind === "client") return [resourceKeys.clients];
      return [resourceKeys.routes];
    },
    ({ version, operation_id, scope, routes }) => {
      const json = { version, operation_id, routes };
      if (scope.kind === "provider")
        return read(
          rpc.providers[":id"]["model-routes"].$put({
            param: { id: scope.id },
            json,
          }),
        );
      if (scope.kind === "client")
        return read(
          rpc.clients[":id"]["model-routes"].$put({
            param: { id: scope.id },
            json,
          }),
        );
      return read(rpc["model-routes"].$put({ json }));
    },
  );
}
