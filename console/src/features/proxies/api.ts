import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { proxyGroupsStatusSchema } from "../../../../src/gateway/proxies/schema";
import { read, rpc } from "@/lib/api";

const PROXY_GROUPS_QUERY_KEY = ["proxy-groups"];

export function useProxyGroups(publishedRevision: number | null | undefined) {
  return useQuery({
    queryKey: [...PROXY_GROUPS_QUERY_KEY, publishedRevision],
    queryFn: async ({ signal }) =>
      proxyGroupsStatusSchema.parse(
        await read(rpc.runtime["proxy-groups"].$get({}, { init: { signal } })),
      ),
    enabled: publishedRevision !== undefined,
    refetchInterval: 15_000,
  });
}

export function useClearProxyHealth() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, proxyId }: { groupId: string; proxyId: string }) =>
      read(
        rpc.runtime["proxy-groups"][":groupId"].proxies[
          ":proxyId"
        ].health.$delete({
          param: { groupId, proxyId },
        }),
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: PROXY_GROUPS_QUERY_KEY }),
  });
}
