import { resourceKeys } from "@/lib/resources";
import type { GatewayConfig } from "../../../../src/config/types";
import { rpc, read } from "@/lib/api";
import { useConfigurationMutation } from "@/lib/configuration-mutation";
export function useSaveReporting() {
  return useConfigurationMutation<{
    version: number;
    reporting: NonNullable<GatewayConfig["reporting"]>;
  }>([resourceKeys.reporting], ({ version, operation_id, reporting }) =>
    read(
      rpc.settings.reporting.$put({
        json: { version, operation_id, reporting },
      }),
    ),
  );
}
export function useSaveWebSearch() {
  return useConfigurationMutation<{
    version: number;
    web_search: GatewayConfig["web_search"];
  }>([resourceKeys.search], ({ version, operation_id, web_search }) =>
    read(
      rpc.settings["web-search"].$put({
        json: { version, operation_id, web_search },
      }),
    ),
  );
}
