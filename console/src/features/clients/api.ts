import { resourceKeys } from "@/lib/resources";
import type { ClientApiKeyConfig } from "../../../../src/config/types";
import { rpc, read } from "@/lib/api";
import {
  useConfigurationMutation,
  withoutId,
} from "@/lib/configuration-mutation";
export function useSaveClient() {
  return useConfigurationMutation<{
    version: number;
    id: string | null;
    client: ClientApiKeyConfig;
  }>([resourceKeys.clients, ["entity-names"]], (input) => {
    const json = {
      version: input.version,
      operation_id: input.operation_id,
      client: withoutId(input.client),
    };
    return input.id === null
      ? read(rpc.clients.$post({ json }))
      : read(rpc.clients[":id"].$put({ param: { id: input.id }, json }));
  });
}
export function useDeleteClient() {
  return useConfigurationMutation<{ version: number; id: string }>(
    [resourceKeys.clients, ["entity-names"]],
    ({ version, operation_id, id }) =>
      read(
        rpc.clients[":id"].$delete({
          param: { id },
          json: { version, operation_id },
        }),
      ),
  );
}
