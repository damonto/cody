import type { ConfigurationOperation } from "../unit-of-work.ts";
import type { GatewayConfig } from "../../config/types.ts";
import type { ControlStore } from "../store.ts";
import { routeTables } from "../repository.ts";
import { routesFromEntities } from "../compiler.ts";
import { replaceRoutes } from "./shared.ts";
export class RoutingService {
  constructor(private readonly store: ControlStore) {}
  list() {
    return this.store.resource(routeTables, (rows) =>
      routesFromEntities(rows, "global"),
    );
  }
  save(
    operation: ConfigurationOperation,
    routes: GatewayConfig["model_routes"],
  ) {
    return this.store.mutate(
      operation,
      (work) => replaceRoutes(work, "global", null, routes),
      (config) => config.model_routes,
    );
  }
}
