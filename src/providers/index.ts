import type {
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import { ProviderType } from "../config/values.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import { aiGatewayAdapter } from "./ai-gateway.ts";
import { antigravityAdapter } from "./antigravity/index.ts";
import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { xaiAdapter } from "./xai/index.ts";
import { credentialMatchesProvider, resolveCredential } from "./credentials.ts";
import { providerConnection } from "./outbound.ts";
import { providerTransportPolicy } from "./transport.ts";
import { ProviderTransport } from "./transport-values.ts";
import type {
  PreparedProviderResult,
  ProviderAdapter,
  ProviderEndpoint,
  ProviderRequest,
  ProviderRuntimeContext,
} from "./types.ts";

/** Capture the discriminated provider once; every adapter uses the same lifecycle. */
function bindAdapter<Provider extends ProviderConfig>(
  provider: Provider,
  adapter: ProviderAdapter<Provider>,
) {
  return {
    supports: (endpoint: ProviderEndpoint, transport: ProviderTransport) =>
      adapter.supports(provider, endpoint, transport),
    async prepare(
      credential: ProviderCredentialConfig,
      input: ProviderRequest,
      context?: ProviderRuntimeContext,
    ): Promise<PreparedProviderResult> {
      if (!adapter.supports(provider, input.endpoint, input.transport))
        throw new Error(
          `Provider ${provider.id} does not support this endpoint and transport`,
        );
      adapter.validate?.(input);
      const local = await adapter.local?.(provider, input);
      if (local) return { kind: "local", response: local };

      const resolved = await resolveCredential(
        credential,
        context && { ...context, provider, credential },
      );
      if (!credentialMatchesProvider<Provider["type"]>(resolved, provider.type))
        throw new Error("Provider and credential authentication do not match");
      const prepared = await adapter.prepare(
        provider,
        resolved,
        input,
        context && {
          ...context,
          connection: providerConnection(provider, credential),
        },
      );
      return {
        kind: "upstream",
        ...prepared,
        ...createUpstreamTransport(
          provider,
          credential,
          context && { ...context, clientSignal: input.request.signal },
          providerTransportPolicy(provider.type, context?.env),
        ),
      };
    },
  };
}

function providerAdapter(provider: ProviderConfig) {
  switch (provider.type) {
    case ProviderType.AiGateway:
      return bindAdapter(provider, aiGatewayAdapter);
    case ProviderType.Antigravity:
      return bindAdapter(provider, antigravityAdapter);
    case ProviderType.Codex:
      return bindAdapter(provider, codexAdapter);
    case ProviderType.Claude:
      return bindAdapter(provider, claudeAdapter);
    case ProviderType.Xai:
      return bindAdapter(provider, xaiAdapter);
  }
}

export function providerSupportsEndpoint(
  provider: ProviderConfig,
  endpoint: ProviderEndpoint,
  transport: ProviderTransport = ProviderTransport.Http,
): boolean {
  return providerAdapter(provider).supports(endpoint, transport);
}

/** Resolve auth once so configured retries reuse the same credential snapshot. */
export function prepareProviderRequest(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
  input: ProviderRequest,
  context?: ProviderRuntimeContext,
): Promise<PreparedProviderResult> {
  return providerAdapter(provider).prepare(credential, input, context);
}
