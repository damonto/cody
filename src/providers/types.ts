import { type ProviderTransport } from "./transport-values.ts";
import { type ApiProtocol } from "../gateway/protocol-values.ts";

import type { NormalizedUsage } from "../billing/types.ts";
import type { ProviderConfig } from "../config/types.ts";
import type { GatewayEndpoint } from "../gateway/protocol.ts";
import type { ProxyTransportContext } from "../gateway/proxies/transport.ts";
import type { UpstreamTransport } from "../gateway/transport/index.ts";
import type { ResolvedCredentialForProvider } from "./credentials.ts";
import type { Bindings } from "../platform/bindings.ts";

export interface ProviderRuntimeContext extends Omit<
  ProxyTransportContext,
  "clientSignal" | "env"
> {
  readonly env: Pick<
    Bindings,
    | "PROXY_GROUP"
    | "PROVIDER_OAUTH_ACCOUNT"
    | "CONFIG_ENCRYPTION_KEY"
    | "UPSTREAM_HTTP"
  > &
    Partial<Pick<Bindings, "CODY_CONFIG_KV">>;
}

export type ProviderEndpoint = Exclude<GatewayEndpoint, "health" | "sessions">;
export type { ProviderTransport } from "./transport-values.ts";

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

export interface AccountLimit {
  readonly code: string;
  readonly resets_at: number;
}

export interface InspectedResponse {
  readonly response: Response;
  readonly accountLimit?: AccountLimit;
}

export interface PreparedUpstreamRequest {
  /** Inspect before returning any bytes; observe later stream limits without replay. */
  readonly inspectResponse?: (
    response: Response,
    onStreamLimit: (limit: AccountLimit) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<InspectedResponse>;
  readonly oauthGeneration?: number;
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
    credential: ResolvedCredentialForProvider<Provider["type"]>,
    input: ProviderRequest,
    context?: ProviderRuntimeContext,
  ): PreparedUpstreamRequest | Promise<PreparedUpstreamRequest>;
}
