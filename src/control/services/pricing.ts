import type { ConfigurationOperation } from "../unit-of-work.ts";
import type { z } from "zod";
import type { modelPriceSchema } from "../../billing/schema.ts";
import type { ControlStore } from "../store.ts";
import { priceTables } from "../repository.ts";
import { live, pricesFromEntities } from "../compiler.ts";
import { required } from "../errors.ts";
import { modelFor, modelFamily, put } from "./shared.ts";

type Pricing = NonNullable<z.infer<typeof modelPriceSchema>["pricing"]>;
export class PricingService {
  constructor(private readonly store: ControlStore) {}
  list() {
    return this.store.resource(priceTables, pricesFromEntities);
  }
  get(id: string) {
    return this.store.resource(priceTables, (rows) => {
      const model = required(
        live(rows.provider_models).find((row) => row.id === id),
        "Provider model",
      );
      return (
        pricesFromEntities(rows).find(
          (row) =>
            row.provider_id === model.provider_id && row.model === model.model,
        ) ?? null
      );
    });
  }
  save(operation: ConfigurationOperation, id: string, pricing: Pricing) {
    return this.write(operation, id, "model", pricing);
  }
  saveFamily(
    operation: ConfigurationOperation,
    id: string,
    pricing: Pricing | null,
  ) {
    return this.write(operation, id, "family", pricing);
  }
  remove(operation: ConfigurationOperation, id: string) {
    return this.write(operation, id, "model", null);
  }
  private write(
    operation: ConfigurationOperation,
    id: string,
    scope: "model" | "family",
    pricing: Pricing | null,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        const models =
          scope === "family"
            ? modelFamily(work.rows, id)
            : [
                required(
                  live(work.rows.provider_models).find((row) => row.id === id),
                  "Provider model",
                ),
              ];
        if (pricing === null) {
          const ids = new Set(models.map((model) => model.id));
          work.rows.model_prices = work.rows.model_prices.filter(
            (row) => !ids.has(row.provider_model_id),
          );
          return;
        }
        const pricingJson = JSON.stringify(pricing);
        for (const model of models) {
          const old = work.rows.model_prices.find(
            (row) => row.provider_model_id === model.id,
          );
          put(work.rows.model_prices, {
            ...work.metadata(old),
            provider_model_id: model.id,
            pricing_json: pricingJson,
          });
        }
      },
      (config) => {
        const model = modelFor(config, id);
        const price = config.model_prices?.find(
          (row) =>
            row.provider_id === model.provider.id && row.model === model.name,
        );
        if (!price) return null;
        // Runtime version metadata is not part of the editable resource or its fingerprint.
        const { version_id: _version, ...item } = price;
        return item;
      },
    );
  }
}
