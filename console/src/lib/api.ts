import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { z } from "zod";
import { toast } from "sonner";
import { createAdminClient } from "../../../src/admin/client";
import type { GatewayConfig } from "../../../src/config/types";
export type { GatewayConfig } from "../../../src/config/types";
export type { UsageEvent } from "../../../src/telemetry/types";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
const errorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({ message: z.string() }).transform((error) => error.message),
  ]),
});
export const rpc = createAdminClient(`${import.meta.env.BASE_URL}api`, {
  headers: { "x-cody-admin": "1" },
  init: { credentials: "same-origin" },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new ApiError(
        "Could not read the console response. Refresh to check your sign-in.",
        response.status,
      );
    }
    if (!response.ok) {
      const result = errorSchema.safeParse(await response.json());
      throw new ApiError(
        result.success
          ? result.data.error
          : `Request failed (${response.status})`,
        response.status,
      );
    }
    return response;
  },
});
export const read = parseResponse;
export type Draft = InferResponseType<typeof rpc.config.$get, 200>;
export type Revision = InferResponseType<
  typeof rpc.config.versions.$get,
  200
>["items"][number];
export type Summary = InferResponseType<typeof rpc.summary.$get, 200>;
export type Aggregate = Summary["totals"];
export type RequestPage = InferResponseType<typeof rpc.requests.$get, 200>;

export const draftOptions = queryOptions({
  queryKey: ["config"],
  queryFn: ({ signal }) => read(rpc.config.$get({}, { init: { signal } })),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});
export function useDraft() {
  return useQuery(draftOptions);
}
export function useSaveDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      config,
      version,
    }: {
      config: GatewayConfig;
      version: number;
    }) => read(rpc.config.$put({ json: { config, version } })),
    onSuccess: (draft) => {
      client.setQueryData(draftOptions.queryKey, draft);
      toast.success("Draft saved", {
        description: "Publish when your changes are ready.",
      });
    },
    onError: (error) => toast.error(error.message),
  });
}
export function params(values: Record<string, string | undefined>): string {
  return new URLSearchParams(
    Object.entries(values).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  ).toString();
}
