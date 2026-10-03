import { xaiAdapter } from "./xai/index.ts";
import { ProviderType, CredentialAuthType } from "../config/values.ts";
import { ProviderTransport } from "./transport-values.ts";

import type {
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import { aiGatewayAdapter } from "./ai-gateway.ts";
import { antigravityAdapter } from "./antigravity/index.ts";
import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { resolveCredential } from "./credentials.ts";
import { providerTransportPolicy } from "./transport.ts";
import type {
  PreparedProviderResult,
  ProviderAdapter,
  ProviderEndpoint,
  ProviderRequest,
  ProviderRuntimeContext,
} from "./types.ts";

const adapters = {
  ai_gateway: aiGatewayAdapter,
  antigravity: antigravityAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
  xai: xaiAdapter,
} satisfies {
  [Type in ProviderType]: ProviderAdapter<
    Extract<ProviderConfig, { type: Type }>
  >;
};

export function providerSupportsEndpoint(
  provider: ProviderConfig,
  endpoint: ProviderEndpoint,
  transport: ProviderTransport = ProviderTransport.Http,
): boolean {
  switch (provider.type) {
    case ProviderType.Xai:
      return adapters.xai.supports(provider, endpoint, transport);
    case ProviderType.AiGateway:
      return adapters.ai_gateway.supports(provider, endpoint, transport);
    case ProviderType.Antigravity:
      return adapters.antigravity.supports(provider, endpoint, transport);
    case ProviderType.Claude:
      return adapters.claude.supports(provider, endpoint, transport);
    case ProviderType.Codex:
      return adapters.codex.supports(provider, endpoint, transport);
  }
}

/** Resolve auth once so configured retries reuse the same credential snapshot. */
export async function prepareProviderRequest(
  provider: ProviderConfig,
  credential: ProviderCredentialConfig,
  input: ProviderRequest,
  context?: ProviderRuntimeContext,
): Promise<PreparedProviderResult> {
  if (!providerSupportsEndpoint(provider, input.endpoint, input.transport)) {
    throw new Error(
      `Provider ${provider.id} does not support this endpoint and transport`,
    );
  }
  if (provider.type === ProviderType.Xai) {
    const response = await xaiAdapter.local?.(provider, input);
    if (response) return { kind: "local", response };
  }
  const resolved = await resolveCredential(
    credential,
    context && { ...context, provider, credential },
  );
  const prepared =
    provider.type === ProviderType.AiGateway &&
    resolved.type === CredentialAuthType.ApiKey
      ? await adapters.ai_gateway.prepare(provider, resolved, input, context)
      : provider.type === ProviderType.Antigravity &&
          resolved.type === CredentialAuthType.OAuth &&
          resolved.provider === ProviderType.Antigravity
        ? await adapters.antigravity.prepare(provider, resolved, input, context)
        : provider.type === ProviderType.Codex &&
            resolved.type === CredentialAuthType.OAuth &&
            resolved.provider === ProviderType.Codex
          ? await adapters.codex.prepare(provider, resolved, input, context)
          : provider.type === ProviderType.Claude &&
              resolved.type === CredentialAuthType.OAuth &&
              resolved.provider === ProviderType.Claude
            ? await adapters.claude.prepare(provider, resolved, input, context)
            : provider.type === ProviderType.Xai &&
                resolved.type === CredentialAuthType.OAuth &&
                resolved.provider === ProviderType.Xai
              ? await adapters.xai.prepare(provider, resolved, input, context)
              : undefined;
  if (!prepared)
    throw new Error("Provider and credential authentication do not match");
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
}
