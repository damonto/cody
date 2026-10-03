import { queryOptions, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { z } from "zod";
import { createAdminClient } from "../../../src/admin/client";
import { apiKeySchema } from "../../../src/admin/credential-schema";
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
  login_url: z.string().optional(),
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
      if (
        response.status === 401 &&
        result.success &&
        result.data.login_url === "/console/auth/login"
      ) {
        const login = new URL(result.data.login_url, window.location.origin);
        login.searchParams.set(
          "return_to",
          window.location.pathname + window.location.search,
        );
        window.location.assign(login.href);
      }
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
      rpc.clients[":id"].reveal.$post(
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
      rpc.providers[":id"].credentials[":credentialId"].reveal.$post(
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
      rpc.settings["web-search"].reveal.$post(
        { json: { version } },
        { init: { signal } },
      ),
    ),
  );
}
export type ConfigurationState = InferResponseType<typeof rpc.config.$get, 200>;

export type Summary = InferResponseType<typeof rpc.summary.$get, 200>;
export type Aggregate = Summary["totals"];

export const configurationStateOptions = queryOptions({
  queryKey: ["configuration-state"],
  queryFn: ({ signal }) => read(rpc.config.$get({}, { init: { signal } })),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
});
export function useConfigurationState() {
  return useQuery(configurationStateOptions);
}
export function useEntityNames() {
  const { data } = useQuery({
    queryKey: ["entity-names"],
    queryFn: () => read(rpc.config.names.$get()),
    staleTime: 30_000,
  });
  return data?.names ?? {};
}
export function params(values: Record<string, string | undefined>): string {
  return new URLSearchParams(
    Object.entries(values).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  ).toString();
}
