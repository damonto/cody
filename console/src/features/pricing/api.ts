import { resourceKeys } from "@/lib/resources";
import type { ModelPrice } from "../../../../src/billing/types";
import { rpc, read } from "@/lib/api";
import { useConfigurationMutation } from "@/lib/configuration-mutation";
export function useSaveModelPrice() {
  return useConfigurationMutation<{
    version: number;
    modelId: string;
    family?: boolean;
    pricing: ModelPrice["pricing"];
  }>(
    [resourceKeys.prices],
    ({ version, operation_id, modelId, pricing, family }) => {
      const model = rpc["model-prices"][":id"];
      const resource = family ? model.family : model;
      const param = { id: modelId };
      return pricing
        ? read(
            resource.$put({
              param,
              json: { version, operation_id, pricing },
            }),
          )
        : read(
            resource.$delete({
              param,
              json: { version, operation_id },
            }),
          );
    },
  );
}
