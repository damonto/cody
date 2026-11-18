import { resourceKeys } from "@/lib/resources";
import type { ModelPrice } from "../../../../src/billing/types";
import { rpc, read } from "@/lib/api";
import { useConfigurationMutation } from "@/lib/configuration-mutation";
export function useSaveModelPrice() {
  return useConfigurationMutation<{
    version: number;
    modelId: string;
    pricing: ModelPrice["pricing"];
  }>([resourceKeys.prices], ({ version, operation_id, modelId, pricing }) => {
    const model = rpc["model-prices"][":id"];
    const param = { id: modelId };
    return pricing
      ? read(
          model.$put({
            param,
            json: { version, operation_id, pricing },
          }),
        )
      : read(
          model.$delete({
            param,
            json: { version, operation_id },
          }),
        );
  });
}
