import type {
  ProviderConfig,
  ProviderCredentialConfig,
  ProviderType,
} from "../config/types.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import { aiGatewayAdapter } from "./ai-gateway.ts";
import { antigravityAdapter } from "./antigravity/index.ts";
import { resolveCredential } from "./credentials.ts";
import type {
  PreparedProviderRequest,
  ProviderAdapter,
  ProviderEndpoint,
  ProviderRequest,
  ProviderRuntimeContext,
  ProviderTransport,
} from "./types.ts";

const adapters = {
  ai_gateway: aiGatewayAdapter,
  antigravity: antigravityAdapter,
} satisfies {
  [Type in ProviderType]: ProviderAdapter<
    Extract<ProviderConfig, { type: Type }>
  >;
};

export function providerSupportsEndpoint(
  provider: ProviderConfig,
  endpoint: ProviderEndpoint,
  transport: ProviderTransport = "http",
): boolean {
  return provider.type === "ai_gateway"
    ? adapters.ai_gateway.supports(provider, endpoint, transport)
    : adapters.antigravity.supports(provider, endpoint, transport);
}

/** Resolve auth once so configured retries reuse the same credential snapshot. */
export async function prepareProviderRequest(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
  input: ProviderRequest,
  context?: ProviderRuntimeContext,
): Promise<PreparedProviderRequest> {
  if (!providerSupportsEndpoint(provider, input.endpoint, input.transport)) {
    throw new Error(
      `Provider ${provider.id} does not support this endpoint and transport`,
    );
  }
  const resolved = await resolveCredential(
    credential,
    context && { ...context, provider, credential },
  );
  const prepared =
    provider.type === "ai_gateway" && resolved.type === "api_key"
      ? await adapters.ai_gateway.prepare(provider, resolved, input, context)
      : provider.type === "antigravity" && resolved.type === "oauth"
        ? await adapters.antigravity.prepare(provider, resolved, input, context)
        : undefined;
  if (!prepared)
    throw new Error("Provider and credential authentication do not match");
  return {
    ...prepared,
    ...createUpstreamTransport(
      provider,
      credential,
      context && { ...context, clientSignal: input.request.signal },
    ),
  };
}
