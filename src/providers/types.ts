import type { ProviderConfig } from "../config/types.ts";
import type { GatewayEndpoint } from "../gateway/protocol.ts";
import type { UpstreamFetch } from "../gateway/transport/index.ts";
import type { ResolvedCredential } from "./credentials.ts";

export type ProviderEndpoint = Exclude<GatewayEndpoint, "health" | "sessions">;
export type ProviderTransport = "http" | "websocket";

export interface ProviderRequest {
  readonly request: Request;
  readonly endpoint: ProviderEndpoint;
  readonly transport: ProviderTransport;
}

export interface PreparedUpstreamRequest {
  readonly url: string;
  readonly headers: Headers;
}

export interface PreparedProviderRequest extends PreparedUpstreamRequest {
  readonly send: UpstreamFetch;
}

/** Adapters prepare one upstream attempt. Retries and health remain in the gateway. */
export interface ProviderAdapter<
  Provider extends ProviderConfig = ProviderConfig,
> {
  readonly type: Provider["type"];
  supports(
    provider: Provider,
    endpoint: ProviderEndpoint,
    transport: ProviderTransport,
  ): boolean;
  prepare(
    provider: Provider,
    credential: ResolvedCredential,
    input: ProviderRequest,
  ): PreparedUpstreamRequest;
}
