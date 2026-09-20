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
import { apiKeySchema } from "../../../src/admin/credential-schema";
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
function apiKey(value: unknown): string {
  const result = apiKeySchema.safeParse(value);
  if (!result.success) throw new ApiError("Could not read the API key", 502);
  return result.data.api_key;
}
export async function revealClientKey(
  id: string,
  version: number,
  signal: AbortSignal,
): Promise<string> {
  return apiKey(
    await read(
      rpc.config.clients[":id"].reveal.$post(
        { param: { id }, json: { version } },
        { init: { signal } },
      ),
    ),
  );
}
export async function revealProviderCredential(
  id: string,
  credentialId: string,
  version: number,
  signal: AbortSignal,
): Promise<string> {
  return apiKey(
    await read(
      rpc.config.providers[":id"].credentials[":credentialId"].reveal.$post(
        { param: { id, credentialId }, json: { version } },
        { init: { signal } },
      ),
    ),
  );
}
export async function revealSearchKey(
  version: number,
  signal: AbortSignal,
): Promise<string> {
  return apiKey(
    await read(
      rpc.config["web-search"].reveal.$post(
        { json: { version } },
        { init: { signal } },
      ),
    ),
  );
}
export type Draft = InferResponseType<typeof rpc.config.$get, 200>;

export type Summary = InferResponseType<typeof rpc.summary.$get, 200>;
export type Aggregate = Summary["totals"];

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
