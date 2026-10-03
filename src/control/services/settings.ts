import { z } from "zod";
import { searchSchema } from "../../config/schema.ts";
import type { GatewayConfig } from "../../config/types.ts";
import type { ControlStore } from "../store.ts";
import { reportingFromEntities, searchFromEntities } from "../compiler.ts";
import { maskSecrets } from "../secrets.ts";
import { ControlNotFound } from "../errors.ts";
import type { ConfigurationOperation } from "../unit-of-work.ts";

export class SettingsService {
  constructor(private readonly store: ControlStore) {}
  reporting() {
    return this.store.resource(["settings"], reportingFromEntities);
  }
  search() {
    return this.store.resource(["settings"], searchFromEntities, (item) =>
      searchSchema.parse(maskSecrets(item)),
    );
  }
  saveReporting(
    operation: ConfigurationOperation,
    input: NonNullable<GatewayConfig["reporting"]>,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        work.rows.settings = work.rows.settings.filter(
          (row) => row.name !== "reporting",
        );
        work.rows.settings.push({
          name: "reporting",
          value_json: JSON.stringify(input),
          secret_id: null,
        });
      },
      (config) => config.reporting,
    );
  }
  saveSearch(
    operation: ConfigurationOperation,
    input: GatewayConfig["web_search"],
  ) {
    return this.store.mutate(
      operation,
      async (work) => {
        const old = work.rows.settings.find((row) => row.name === "web_search");
        const oldMode = old
          ? z.object({ mode: z.string() }).parse(JSON.parse(old.value_json))
              .mode
          : "proxy";
        const secret_id =
          input.mode === "proxy"
            ? null
            : await work.secrets.seal(
                "web_search",
                "api_key",
                input.api_key,
                oldMode === input.mode ? old?.secret_id : null,
              );
        const value =
          input.mode === "proxy" ? input : { ...input, api_key: "" };
        work.rows.settings = work.rows.settings.filter(
          (row) => row.name !== "web_search",
        );
        work.rows.settings.push({
          name: "web_search",
          value_json: JSON.stringify(value),
          secret_id,
        });
      },
      (config) => config.web_search,
    );
  }
  revealSearch(version: number) {
    return this.store.reveal(["settings"], version, async (rows, secrets) => {
      const row = rows.settings.find((row) => row.name === "web_search");
      if (!row?.secret_id)
        throw new ControlNotFound("No search provider key is configured");
      return { api_key: await secrets.read(row.secret_id) };
    });
  }
}
