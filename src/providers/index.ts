import type {
  ProviderConfig,
  ProviderCredentialConfig,
  ProviderType,
} from "../config/types.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import type { ProxyTransportContext } from "../gateway/proxies/transport.ts";
import { aiGatewayAdapter } from "./ai-gateway.ts";
import { resolveCredential } from "./credentials.ts";
import type {
  PreparedProviderRequest,
  ProviderAdapter,
  ProviderEndpoint,
  ProviderRequest,
  ProviderTransport,
} from "./types.ts";

const adapters = { ai_gateway: aiGatewayAdapter } satisfies {
  [Type in ProviderType]: ProviderAdapter<
    Extract<ProviderConfig, { type: Type }>
  >;
};

export function providerSupportsEndpoint(
  provider: ProviderConfig,
  endpoint: ProviderEndpoint,
  transport: ProviderTransport = "http",
): boolean {
  return adapters[provider.type].supports(provider, endpoint, transport);
}

/** Resolve auth once so configured retries reuse the same credential snapshot. */
export async function prepareProviderRequest(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
  input: ProviderRequest,
  context?: Omit<ProxyTransportContext, "clientSignal">,
): Promise<PreparedProviderRequest> {
  const adapter = adapters[provider.type];
  if (!adapter.supports(provider, input.endpoint, input.transport)) {
    throw new Error(
      `Provider ${provider.id} does not support this endpoint and transport`,
    );
  }
  const resolved = await resolveCredential(credential);
  return {
    ...adapter.prepare(provider, resolved, input),
    ...createUpstreamTransport(
      provider,
      credential,
      context && { ...context, clientSignal: input.request.signal },
    ),
  };
}
