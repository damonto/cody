import { resourceKeys } from "@/lib/resources";
import type {
  ProxyGroupConfig,
  ProxyNodeConfig,
} from "../../../../src/config/types";
import { rpc, read } from "@/lib/api";
import {
  useConfigurationMutation,
  withoutId,
} from "@/lib/configuration-mutation";
export function useSaveProxyGroup() {
  return useConfigurationMutation<{
    version: number;
    id: string | null;
    group: ProxyGroupConfig;
  }>([resourceKeys.proxies, ["entity-names"]], (input) => {
    const json = {
      version: input.version,
      operation_id: input.operation_id,
      group: withoutId(input.group),
    };
    return input.id === null
      ? read(rpc["proxy-groups"].$post({ json }))
      : read(
          rpc["proxy-groups"][":id"].$put({ param: { id: input.id }, json }),
        );
  });
}
export function useSaveProxyNode() {
  return useConfigurationMutation<{
    version: number;
    groupId: string;
    id: string | null;
    node: ProxyNodeConfig;
  }>([resourceKeys.proxies, ["entity-names"]], (input) => {
    const json = {
      version: input.version,
      operation_id: input.operation_id,
      node: withoutId(input.node),
    };
    const group = rpc["proxy-groups"][":id"];
    return input.id === null
      ? read(group.nodes.$post({ param: { id: input.groupId }, json }))
      : read(
          group.nodes[":nodeId"].$put({
            param: { id: input.groupId, nodeId: input.id },
            json,
          }),
        );
  });
}
export function useDeleteProxy() {
  return useConfigurationMutation<{
    version: number;
    groupId: string;
    nodeId: string | null;
  }>(
    [resourceKeys.proxies, ["entity-names"]],
    ({ version, operation_id, groupId, nodeId }) => {
      const group = rpc["proxy-groups"][":id"];
      const json = { version, operation_id };
      return nodeId === null
        ? read(group.$delete({ param: { id: groupId }, json }))
        : read(
            group.nodes[":nodeId"].$delete({
              param: { id: groupId, nodeId },
              json,
            }),
          );
    },
  );
}
