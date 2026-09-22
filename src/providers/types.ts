import type { NormalizedUsage } from "../billing/types.ts";
import type { ProviderConfig } from "../config/types.ts";
import type { GatewayEndpoint, ApiProtocol } from "../gateway/protocol.ts";
import type { ProxyTransportContext } from "../gateway/proxies/transport.ts";
import type { UpstreamTransport } from "../gateway/transport/index.ts";
import type { ResolvedCredentialFor } from "./credentials.ts";

export interface ProviderRuntimeContext extends Omit<
  ProxyTransportContext,
  "clientSignal" | "env"
> {
  readonly env: Pick<
    Env,
    "PROXY_GROUP" | "PROVIDER_OAUTH_ACCOUNT" | "CONFIG_ENCRYPTION_KEY"
  >;
}

export type ProviderEndpoint = Exclude<GatewayEndpoint, "health" | "sessions">;
export type ProviderTransport = "http" | "websocket";

export interface ProviderRequest {
  readonly request: Request;
  readonly endpoint: ProviderEndpoint;
  readonly transport: ProviderTransport;
  /** Request dialect, resolved by the gateway with `requestProtocol`. */
  readonly protocol: ApiProtocol;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly model?: string;
  readonly clientId?: string;
  readonly sessionId?: string | undefined;
}

export interface PreparedUpstreamRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly method?: string;
  readonly body?: string;
  readonly transformResponse?: (response: Response) => Promise<Response>;
  readonly parseModels?: (value: unknown) => unknown;
  readonly retryUsage?: (response: Response) => Promise<NormalizedUsage | null>;
}

export interface PreparedProviderRequest
  extends PreparedUpstreamRequest, UpstreamTransport {}

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
    credential: ResolvedCredentialFor<Provider["credentials"][number]["auth"]>,
    input: ProviderRequest,
    context?: ProviderRuntimeContext,
  ): PreparedUpstreamRequest | Promise<PreparedUpstreamRequest>;
}
