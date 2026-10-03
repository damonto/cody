import type { ConfigurationOperation } from "../unit-of-work.ts";
import type { z } from "zod";
import type { modelPriceSchema } from "../../billing/schema.ts";
import type { ControlStore } from "../store.ts";
import { priceTables } from "../repository.ts";
import { live, pricesFromEntities } from "../compiler.ts";
import { required } from "../errors.ts";
import { modelFor, put } from "./shared.ts";

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
    return this.store.mutate(
      operation,
      (work) => {
        required(
          live(work.rows.provider_models).find((row) => row.id === id),
          "Provider model",
        );
        const old = work.rows.model_prices.find(
          (row) => row.provider_model_id === id,
        );
        put(work.rows.model_prices, {
          ...work.metadata(old),
          provider_model_id: id,
          pricing_json: JSON.stringify(pricing),
        });
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
  remove(operation: ConfigurationOperation, id: string) {
    return this.store.mutate(
      operation,
      (work) => {
        required(
          live(work.rows.provider_models).find((row) => row.id === id),
          "Provider model",
        );
        work.rows.model_prices = work.rows.model_prices.filter(
          (row) => row.provider_model_id !== id,
        );
      },
      () => null,
    );
  }
}
