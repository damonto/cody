import type { ConfigurationOperation } from "../unit-of-work.ts";
import type { z } from "zod";
import { clientSchema } from "../../config/schema.ts";
import type { GatewayConfig } from "../../config/types.ts";
import type { ControlStore } from "../store.ts";
import type { clientInputSchema } from "../resource-input.ts";
import { clientTables } from "../repository.ts";
import { clientsFromEntities, live } from "../compiler.ts";
import { maskSecrets } from "../secrets.ts";
import { required } from "../errors.ts";
import { clientFor, put, replaceRoutes, removeRoutes } from "./shared.ts";

type ClientInput = z.infer<typeof clientInputSchema>;
export class ClientService {
  constructor(private readonly store: ControlStore) {}
  list() {
    return this.store.resource(clientTables, clientsFromEntities, (items) =>
      items.map((item) => clientSchema.parse(maskSecrets(item))),
    );
  }

  async get(id: string) {
    const result = await this.list();
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === id),
        "Client",
      ),
    };
  }
  save(operation: ConfigurationOperation, input: ClientInput, id?: string) {
    return this.store.mutate(
      operation,
      async (work) => {
        const { rows } = work;
        const old = id
          ? required(
              live(rows.clients).find((row) => row.id === id),
              "Client",
            )
          : undefined;
        const metadata = work.metadata(old);
        put(rows.clients, {
          ...metadata,
          name: input.name,
          position: old?.position ?? rows.clients.length,
          secret_id: await work.secrets.seal(
            metadata.id,
            "api_key",
            input.api_key,
            old?.secret_id,
          ),
        });
        rows.client_providers = rows.client_providers.filter(
          (row) => row.client_id !== metadata.id,
        );
        rows.client_providers.push(
          ...input.providers.map((provider_id, position) => ({
            client_id: metadata.id,
            provider_id,
            position,
            deleted_at: null,
          })),
        );
        replaceRoutes(work, "client", metadata.id, input.model_routes ?? {});
      },
      (config) =>
        id ? clientFor(config, id) : required(config.api_keys.at(-1), "Client"),
    );
  }
  remove(operation: ConfigurationOperation, id: string) {
    return this.store.mutate(
      operation,
      (work) => {
        const { rows } = work;
        required(
          live(rows.clients).find((row) => row.id === id),
          "Client",
        );
        rows.clients = rows.clients.filter((row) => row.id !== id);
        rows.client_providers = rows.client_providers.filter(
          (row) => row.client_id !== id,
        );
        removeRoutes(work, "client", id);
      },
      () => null,
    );
  }
  reveal(id: string, version: number) {
    return this.store.reveal(["clients"], version, async (rows, secrets) => ({
      api_key: await secrets.read(
        required(
          live(rows.clients).find((row) => row.id === id),
          "Client",
        ).secret_id,
      ),
    }));
  }
  async routes(id: string) {
    const result = await this.get(id);
    return { ...result, item: result.item.model_routes ?? {} };
  }
  saveRoutes(
    operation: ConfigurationOperation,
    id: string,
    routes: GatewayConfig["model_routes"],
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        required(
          live(work.rows.clients).find((row) => row.id === id),
          "Client",
        );
        replaceRoutes(work, "client", id, routes);
      },
      (config) => clientFor(config, id).model_routes ?? {},
    );
  }
}
