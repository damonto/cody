import {
  chooseAffinityCandidate,
  sessionAffinityIdentity,
  type AffinityProviderCandidate,
} from "./affinity.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import {
  getCredentialAvailability,
  getProviderAvailability,
  type HealthScope,
  type ProviderAvailability,
} from "../health/health.ts";
import { errorMessage } from "../../shared/log.ts";
import { providerSupportsEndpoint } from "../../providers/index.ts";
import type {
  ProviderEndpoint,
  ProviderTransport,
} from "../../providers/types.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ProviderCredentialConfig,
  ProviderConfig,
} from "../../config/types.ts";

export interface ModelRoute {
  requestedModel: string;
  targets: ModelRoutedProvider[];
}

export interface RoutedProvider {
  provider: ProviderConfig;
  credentials: ProviderCredentialConfig[];
}

interface ModelRoutedProvider extends RoutedProvider {
  upstreamModel: string;
  routeApplied: boolean;
}

export interface ProviderTarget {
  provider: ProviderConfig;
  credential: ProviderCredentialConfig;
}

export interface ModelProviderTarget extends ProviderTarget {
  upstreamModel: string;
  routeApplied: boolean;
}

interface ProviderSelectionCheck extends ProviderAvailability {
  provider_id: string;
}

interface CredentialSelectionCheck extends ProviderAvailability {
  provider_id: string;
  credential_id: string;
}

interface SelectionAffinity {
  status: "hit" | "created" | "rebound" | "failed" | "blocked" | "forbidden";
  error?: string;
  context_management?: boolean;
}

export interface TargetSelection {
  // Always present, possibly undefined: selection computes a target that may
  // not exist. `affinity` is genuinely absent when no session was involved.
  target: ProviderTarget | undefined;
  checks: ProviderSelectionCheck[];
  credentialChecks: CredentialSelectionCheck[];
  affinity?: SelectionAffinity;
}

export interface ProviderSelection extends TargetSelection {
  target: ModelProviderTarget | undefined;
}

export interface ProviderSelectionOptions {
  scope?: HealthScope;
  contextManagement?: boolean;
  initialProviderIds?: readonly string[];
  session?: {
    clientId: string;
    sessionId: string;
  };
}

type RequiredProviderCapability =
  "supports_websocket" | "supports_web_search" | "supports_context_management";

export interface ResolveModelRouteOptions {
  requiredCapabilities?: readonly RequiredProviderCapability[];
  endpoint?: ProviderEndpoint;
  transport?: ProviderTransport;
}

export interface CatalogSelection {
  targets: ProviderTarget[];
  checks: ProviderSelectionCheck[];
  credentialChecks: CredentialSelectionCheck[];
}

interface RouteAvailability<T extends RoutedProvider> {
  candidates: T[];
  checks: ProviderSelectionCheck[];
  credentialChecks: CredentialSelectionCheck[];
}

function modelRoutesForProvider(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  provider: ProviderConfig,
): Record<string, ModelRouteConfig> {
  return {
    ...config.model_routes,
    ...client.model_routes,
    ...provider.model_routes,
  };
}

export function modelRoutesByProvider(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): Map<string, Record<string, ModelRouteConfig>> {
  const allowedProviders = new Set(client.providers);
  return new Map(
    config.providers
      .filter((provider) => allowedProviders.has(provider.id))
      .map((provider) => [
        provider.id,
        modelRoutesForProvider(config, client, provider),
      ]),
  );
}

export function selectProviderCredential(
  provider: ProviderConfig,
): ProviderCredentialConfig | undefined {
  const enabled = provider.credentials.filter(
    (credential) => !credential.disabled,
  );
  if (enabled.length === 0) {
    return undefined;
  }
  const priority = Math.max(
    ...enabled.map((credential) => credential.priority),
  );
  return enabled.find((credential) => credential.priority === priority);
}

function providerSupportsModel(
  provider: ProviderConfig,
  upstreamModel: string,
): boolean {
  return provider.models.includes(upstreamModel);
}

function routeAllowsProvider(
  route: ModelRouteConfig | undefined,
  providerId: string,
): boolean {
  return route?.providers === undefined || route.providers.includes(providerId);
}

function routedProvider(provider: ProviderConfig): RoutedProvider | undefined {
  const credentials = provider.credentials.filter((key) => !key.disabled);
  return credentials.length > 0 ? { provider, credentials } : undefined;
}

function sortRoutedProviders<T extends RoutedProvider>(
  targets: T[],
  config: GatewayConfig,
): T[] {
  const order = new Map(
    config.providers.map((provider, index) => [provider.id, index]),
  );
  const providerOrder = (providerId: string): number => {
    const index = order.get(providerId);
    if (index === undefined) {
      throw new Error(
        `routed provider ${providerId} is missing from configuration`,
      );
    }
    return index;
  };
  return [...targets].sort(
    (left, right) =>
      right.provider.priority - left.provider.priority ||
      providerOrder(left.provider.id) - providerOrder(right.provider.id),
  );
}

export function resolveModelRoute(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): ModelRoute {
  const allowedProviders = new Set(client.providers);
  const targets = config.providers.flatMap<ModelRoutedProvider>((provider) => {
    if (
      provider.disabled ||
      !allowedProviders.has(provider.id) ||
      (options.endpoint !== undefined &&
        !providerSupportsEndpoint(
          provider,
          options.endpoint,
          options.transport,
        )) ||
      options.requiredCapabilities?.some((capability) => !provider[capability])
    ) {
      return [];
    }
    const modelRoutes = modelRoutesForProvider(config, client, provider);
    const providerRouteApplied = Object.hasOwn(modelRoutes, requestedModel);
    const configuredRoute = providerRouteApplied
      ? modelRoutes[requestedModel]
      : undefined;
    const upstreamModel = configuredRoute?.model ?? requestedModel;
    if (
      !routeAllowsProvider(configuredRoute, provider.id) ||
      !providerSupportsModel(provider, upstreamModel)
    ) {
      return [];
    }
    const target = routedProvider(provider);
    return target
      ? [{ ...target, upstreamModel, routeApplied: providerRouteApplied }]
      : [];
  });
  return {
    requestedModel,
    targets: sortRoutedProviders(targets, config),
  };
}

export function modelIsAvailableForClient(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): boolean {
  return (
    resolveModelRoute(config, client, requestedModel, options).targets.length >
    0
  );
}

export function allowedProviderCandidates(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): RoutedProvider[] {
  const allowed = new Set(client.providers);
  const targets = config.providers.flatMap((provider) => {
    if (provider.disabled || !allowed.has(provider.id)) {
      return [];
    }
    const target = routedProvider(provider);
    return target ? [target] : [];
  });
  return sortRoutedProviders(targets, config);
}

async function evaluateAvailability<T extends RoutedProvider>(
  env: Env,
  routedProviders: T[],
  scope: HealthScope,
): Promise<RouteAvailability<T>> {
  const checks = await mapWithConcurrency(
    routedProviders,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async ({ provider }): Promise<ProviderSelectionCheck> => ({
      provider_id: provider.id,
      ...(await getProviderAvailability(env, provider.id, scope)),
    }),
  );
  const availableProviderIds = new Set(
    checks.filter((check) => check.available).map((check) => check.provider_id),
  );
  const keyDescriptors = routedProviders.flatMap(({ provider, credentials }) =>
    availableProviderIds.has(provider.id)
      ? credentials.map((key) => ({ provider, credential: key }))
      : [],
  );
  const credentialChecks = await mapWithConcurrency(
    keyDescriptors,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async ({
      provider,
      credential: key,
    }): Promise<CredentialSelectionCheck> => ({
      provider_id: provider.id,
      credential_id: key.id,
      ...(await getCredentialAvailability(env, provider.id, key.id, scope)),
    }),
  );
  const availableCredentialIds = new Set(
    credentialChecks
      .filter((check) => check.available)
      .map((check) => `${check.provider_id}\u0000${check.credential_id}`),
  );
  const candidates = routedProviders.flatMap<T>((routed) => {
    const { provider, credentials } = routed;
    if (!availableProviderIds.has(provider.id)) {
      return [];
    }
    const availableKeys = credentials.filter((key) =>
      availableCredentialIds.has(`${provider.id}\u0000${key.id}`),
    );
    return availableKeys.length > 0
      ? [{ ...routed, credentials: availableKeys }]
      : [];
  });
  return { candidates, checks, credentialChecks };
}

function affinityCandidates(
  candidates: RoutedProvider[],
): AffinityProviderCandidate[] {
  return candidates.map(({ provider, credentials }) => ({
    provider_id: provider.id,
    priority: provider.priority,
    supports_context_management: provider.supports_context_management,
    credentials: credentials.map((credential) => ({
      credential_id: credential.id,
      priority: credential.priority,
    })),
  }));
}

function targetByIds(
  candidates: RoutedProvider[],
  providerId: string,
  credentialId: string,
): ProviderTarget | undefined {
  const candidate = candidates.find(
    ({ provider }) => provider.id === providerId,
  );
  const credential = candidate?.credentials.find(
    (entry) => entry.id === credentialId,
  );
  return candidate && credential
    ? {
        provider: candidate.provider,
        credential,
      }
    : undefined;
}

function selectTarget(
  candidates: RoutedProvider[],
): ProviderTarget | undefined {
  const selected = chooseAffinityCandidate(affinityCandidates(candidates));
  return selected
    ? targetByIds(candidates, selected.provider_id, selected.credential_id)
    : undefined;
}

export async function selectAvailableProviderWithDetails(
  env: Env,
  route: ModelRoute,
  options: ProviderSelectionOptions = {},
): Promise<ProviderSelection> {
  const selection = await selectAvailableTargetWithDetails(
    env,
    route.targets,
    options,
  );
  const target = selection.target;
  const routed =
    target &&
    route.targets.find(({ provider }) => provider.id === target.provider.id);
  return {
    ...selection,
    target:
      target && routed
        ? {
            ...target,
            upstreamModel: routed.upstreamModel,
            routeApplied: routed.routeApplied,
          }
        : undefined,
  };
}

export async function selectAvailableTargetWithDetails(
  env: Env,
  providers: RoutedProvider[],
  options: ProviderSelectionOptions = {},
): Promise<TargetSelection> {
  const contextManagement = options.contextManagement === true;
  const availability = await evaluateAvailability(
    env,
    contextManagement
      ? providers.filter(({ provider }) => provider.supports_context_management)
      : providers,
    options.scope ?? "inference",
  );
  if (availability.candidates.length === 0) {
    return {
      target: undefined,
      checks: availability.checks,
      credentialChecks: availability.credentialChecks,
    };
  }

  if (contextManagement && !options.session) {
    return {
      target: undefined,
      checks: availability.checks,
      credentialChecks: availability.credentialChecks,
      affinity: { status: "blocked" },
    };
  }
  if (options.session) {
    const candidates = affinityCandidates(availability.candidates);
    const preferred = chooseAffinityCandidate(candidates);
    try {
      const identity = await sessionAffinityIdentity(
        options.session.clientId,
        options.session.sessionId,
      );
      const resolution = await env.SESSION_AFFINITY.getByName(
        identity.object_name,
      ).resolve(candidates, preferred, identity, {
        contextManagement,
        ...(options.initialProviderIds === undefined
          ? {}
          : { initialProviderIds: options.initialProviderIds }),
      });
      if (!resolution) {
        throw new Error("session affinity returned no candidate");
      }
      if (resolution.status === "blocked") {
        return {
          target: undefined,
          checks: availability.checks,
          credentialChecks: availability.credentialChecks,
          affinity: { status: "blocked" },
        };
      }
      if (resolution.context_management) {
        if (
          !(await env.SESSION_AFFINITY.getByName(
            `context-owner:${identity.session_digest}`,
          ).claimContextSession(options.session.clientId))
        ) {
          return {
            target: undefined,
            checks: availability.checks,
            credentialChecks: availability.credentialChecks,
            affinity: { status: "forbidden" },
          };
        }
      }
      const target = targetByIds(
        availability.candidates,
        resolution.provider_id,
        resolution.credential_id,
      );
      if (!target) {
        throw new Error("session affinity returned an unavailable candidate");
      }
      return {
        target,
        checks: availability.checks,
        credentialChecks: availability.credentialChecks,
        affinity: {
          status: resolution.status,
          ...(resolution.context_management
            ? { context_management: true }
            : {}),
        },
      };
    } catch (error) {
      return {
        target: undefined,
        checks: availability.checks,
        credentialChecks: availability.credentialChecks,
        affinity: { status: "failed", error: errorMessage(error) },
      };
    }
  }

  return {
    target: selectTarget(availability.candidates),
    checks: availability.checks,
    credentialChecks: availability.credentialChecks,
  };
}

export async function selectAvailableProvider(
  env: Env,
  route: ModelRoute,
): Promise<ProviderConfig | undefined> {
  return (await selectAvailableProviderWithDetails(env, route)).target
    ?.provider;
}

export async function selectAvailableCatalogTargetsWithDetails(
  env: Env,
  routedProviders: RoutedProvider[],
): Promise<CatalogSelection> {
  const availability = await evaluateAvailability(
    env,
    routedProviders,
    "catalog",
  );
  const targets = availability.candidates.flatMap(
    ({ provider, credentials }) => {
      const credential = selectProviderCredential({ ...provider, credentials });
      return credential ? [{ provider, credential }] : [];
    },
  );
  return {
    targets,
    checks: availability.checks,
    credentialChecks: availability.credentialChecks,
  };
}

export async function targetIsAvailableForRoute(
  env: Env,
  route: ModelRoute,
  target: ModelProviderTarget,
  scope: HealthScope = "inference",
): Promise<boolean> {
  const routed = route.targets.find(
    ({ provider }) => provider.id === target.provider.id,
  );
  if (!routed?.credentials.some((key) => key.id === target.credential.id)) {
    return false;
  }
  const [providerAvailability, credentialAvailability] = await Promise.all([
    getProviderAvailability(env, target.provider.id, scope),
    getCredentialAvailability(
      env,
      target.provider.id,
      target.credential.id,
      scope,
    ),
  ]);
  return providerAvailability.available && credentialAvailability.available;
}
