import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { proxyGroupsStatusSchema } from "../../../../src/gateway/proxies/schema";
import { proxyTestResultSchema } from "../../../../src/admin/proxy-test-schema";
import { ApiError, read, rpc } from "@/lib/api";

const PROXY_GROUPS_QUERY_KEY = ["proxy-groups"];

export async function testProxyNode(
  groupId: string,
  proxyId: string,
  version: number,
  signal: AbortSignal,
) {
  const result = proxyTestResultSchema.safeParse(
    await read(
      rpc.config["proxy-groups"][":groupId"].proxies[":proxyId"].test.$post(
        { param: { groupId, proxyId }, json: { version } },
        { init: { signal } },
      ),
    ),
  );
  if (!result.success) {
    throw new ApiError(
      "Could not read a valid proxy test result. Try again.",
      502,
    );
  }
  return result.data;
}

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
