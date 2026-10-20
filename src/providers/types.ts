import { type ProviderTransport } from "./transport-values.ts";
import { type ApiProtocol } from "../gateway/protocol-values.ts";

import type { NormalizedUsage } from "../billing/types.ts";
import type { InferenceMetadata } from "../shared/upstream-observation.ts";
import type { UpstreamMetadataObserver } from "../telemetry/inference-metadata.ts";
import type { ProviderConfig } from "../config/types.ts";
import type { GatewayEndpoint } from "../gateway/protocol.ts";
import type { ProxyTransportContext } from "../gateway/proxies/transport.ts";
import type { UpstreamTransport } from "../gateway/transport/index.ts";
import type { ResolvedCredentialForProvider } from "./credentials.ts";
import type { Bindings } from "../platform/bindings.ts";
import type { RetryErrorInspection } from "../gateway/http/retry-errors.ts";
import type { ProviderConnection } from "./oauth/schema.ts";

export interface ProviderRuntimeContext extends Omit<
  ProxyTransportContext,
  "clientSignal" | "env"
> {
  readonly connection?: ProviderConnection;
  readonly env: Pick<
    Bindings,
    | "PROXY_GROUP"
    | "PROVIDER_OAUTH_ACCOUNT"
    | "SESSION_AFFINITY"
    | "CONFIG_ENCRYPTION_KEY"
    | "UPSTREAM_HTTP"
  > &
    Partial<Pick<Bindings, "CODY_CONFIG_KV" | "HEALTH">>;
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
  /** UTF-8 bytes of the decoded client body, before native translation. */
  readonly bodyBytes?: number;
}

export interface AccountLimit {
  readonly code: string;
  readonly resets_at: number;
  readonly model?: string | null;
  readonly kind?: "subscription" | "spending";
  readonly reset_source?: "upstream" | "fallback";
}

export interface InspectedResponse {
  readonly response: Response;
  readonly accountLimit?: AccountLimit;
}

/** A provider binds quota persistence and the exhausted response to this attempt. */
export interface PreparedAccountSwitch {
  readonly limit: AccountLimit;
  persist(): Promise<"recorded" | "unrecorded" | "unavailable">;
  exhausted(response: Response): Response | Promise<Response>;
}

export interface ProviderResponseInspection {
  readonly response: Response;
  readonly accountSwitch?: PreparedAccountSwitch;
  /** Reuse the provider's bounded preflight for configured error-code retries. */
  readonly retry?: Omit<RetryErrorInspection, "response">;
}

/** A provider preflight declares its phase and runs at most once per attempt. */
export type ProviderResponseInspector =
  | {
      /** Runs inside send, under its abort signal and timeout. */
      readonly phase: "transport";
      inspect(
        response: Response,
        signal: AbortSignal,
      ): Promise<ProviderResponseInspection>;
    }
  | {
      /** Shares bounded error parsing and the remaining attempt budget. */
      readonly phase: "retry";
      inspect(
        response: Response,
        signal: AbortSignal,
        timeoutMs: number | undefined,
      ): Promise<ProviderResponseInspection>;
    };

/** Replacement headers for subsequent attempts on the same account. */
export interface RecoveredUpstreamAuth {
  readonly headers: Headers;
}

export interface PreparedUpstreamRequest {
  /** Codex-only recovery of the same OAuth account after an HTTP 401, before output. */
  readonly recoverUnauthorized?: (
    signal: AbortSignal,
  ) => Promise<RecoveredUpstreamAuth | undefined>;
  /** Passive observations must not block forwarding or change retry decisions. */
  readonly observeResponse?: (response: Response) => void;
  readonly observeWebSocketEvent?: (value: unknown, receivedAt: number) => void;
  readonly accountSwitching?: {
    readonly timeoutScope: "request" | "attempt";
  };
  /** Late stream observations may persist limits but never authorize replay. */
  readonly responseInspector?: ProviderResponseInspector;
  readonly observeFinalResponse?: (response: Response) => Promise<void>;
  readonly url: string;
  readonly headers: Headers;
  readonly method?: string;
  readonly body?: string;
  /** Metadata from the adapter's final request body, before serialization. */
  readonly inferenceMetadata?: InferenceMetadata;
  /** Detect JSON/SSE from a bounded body prefix when the media type is unknown. */
  readonly detectResponseFormat?: boolean;
  readonly transformResponse?: (
    response: Response,
    observe?: UpstreamMetadataObserver,
  ) => Promise<Response>;
  readonly parseModels?: (value: unknown) => unknown;
  readonly retryUsage?: (response: Response) => Promise<NormalizedUsage | null>;
}

export interface PreparedLocalResponse {
  readonly kind: "local";
  readonly response: Response;
}
export type PreparedProviderResult =
  PreparedProviderRequest | PreparedLocalResponse;

export interface PreparedProviderRequest
  extends PreparedUpstreamRequest, UpstreamTransport {
  readonly kind: "upstream";
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
  /** Reject invalid input before local handling or credential resolution. */
  validate?(input: ProviderRequest): void;
  local?(
    provider: Provider,
    input: ProviderRequest,
  ): Promise<Response | undefined>;
  prepare(
    provider: Provider,
    credential: ResolvedCredentialForProvider<Provider["type"]>,
    input: ProviderRequest,
    context?: ProviderRuntimeContext,
  ): PreparedUpstreamRequest | Promise<PreparedUpstreamRequest>;
}
