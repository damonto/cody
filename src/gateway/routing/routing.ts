import { supportsProviderModel } from "../../shared/antigravity-models.ts";
import { resolveAntigravityModel } from "../../providers/antigravity/reasoning.ts";
import { ProviderRequestError } from "../../providers/errors.ts";
import { xaiQuotaRoute } from "../../providers/xai/routing.ts";
import { claudeQuotaRoute } from "../../providers/claude/routing.ts";
import { SessionAffinityStatus } from "./values.ts";
import {
  antigravityAccountAvailability,
  antigravityModelAvailability,
} from "../../providers/antigravity/availability.ts";
import { CodexAccountSelection, ProviderType } from "../../config/values.ts";

import { HealthScope, ProviderAvailabilityReason } from "../health/values.ts";
import { type ProviderTransport } from "../../providers/transport-values.ts";

import {
  chooseAffinityCandidate,
  sessionAffinityIdentity,
  type AffinityProviderCandidate,
  type AffinitySelection,
} from "./affinity.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import {
  getCredentialAvailability,
  getProviderAvailability,
  nextRotationCredential,
  type ProviderAvailability,
} from "../health/health.ts";
import { errorMessage } from "../../shared/log.ts";
import { providerSupportsEndpoint } from "../../providers/index.ts";
import type { ProviderEndpoint } from "../../providers/types.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ProviderCredentialConfig,
  ProviderConfig,
} from "../../config/types.ts";
import type { Bindings } from "../../platform/bindings.ts";

export interface ModelRoute {
  requestedModel: string;
  resolutionError?: ProviderRequestError;
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
  status: SessionAffinityStatus;
  error?: string;
  context_management?: boolean;
  /** The binding a blocked context session is waiting for. */
  provider_id?: string;
  credential_id?: string;
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
  xaiQuota?: { allBlocked: boolean; until: number | undefined };
  claudeQuota?: { allBlocked: boolean; until: number | undefined };
  target: ModelProviderTarget | undefined;
}

export interface ProviderSelectionOptions {
  /** Real models resolved per provider; catalogs do not consult inference quotas. */
  upstreamModels?: ReadonlyMap<string, string>;
  scope?: HealthScope;
  skipXaiQuota?: boolean;
  skipClaudeQuota?: boolean;
  contextManagement?: boolean;
  initialProviderIds?: readonly string[];
  /** Credentials this logical request already tried, keyed by `credentialKey`. */
  excludedCredentials?: ReadonlySet<string>;
  session?: {
    clientId: string;
    sessionId: string;
  };
}

type RequiredProviderCapability =
  "supports_websocket" | "supports_web_search" | "supports_context_management";

export interface ResolveModelRouteOptions {
  payload?: Record<string, unknown>;
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

export function selectProviderCredential(provider: {
  credentials: readonly ProviderCredentialConfig[];
}): ProviderCredentialConfig | undefined {
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

function configuredModelRoute(
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
      !supportsProviderModel(provider, upstreamModel)
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

/** Resolve physical variants only for inference, after configured eligibility is established. */
export function resolveModelRoute(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): ModelRoute {
  const route = configuredModelRoute(config, client, requestedModel, options);
  let resolutionError: ProviderRequestError | undefined;
  const targets = route.targets.flatMap<ModelRoutedProvider>((target) => {
    if (target.provider.type !== ProviderType.Antigravity) return [target];
    try {
      return [
        {
          ...target,
          upstreamModel: resolveAntigravityModel(
            target.provider.models,
            target.upstreamModel,
            options.payload,
          ),
        },
      ];
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) throw error;
      resolutionError ??= error;
      return [];
    }
  });
  return {
    requestedModel,
    targets,
    ...(!targets.length && resolutionError ? { resolutionError } : {}),
  };
}

export function modelIsAvailableForClient(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): boolean {
  return (
    configuredModelRoute(config, client, requestedModel, options).targets
      .length > 0
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

/** Account quota decisions require a readable health snapshot. */
function applyHealthReadPolicy(
  provider: ProviderConfig,
  health: ProviderAvailability,
): ProviderAvailability {
  if (
    health.reason === ProviderAvailabilityReason.HealthReadFailed &&
    (provider.type === ProviderType.Antigravity ||
      provider.type === ProviderType.Codex)
  )
    return { ...health, available: false };
  return health;
}

async function evaluateAvailability<T extends RoutedProvider>(
  env: Bindings,
  routedProviders: T[],
  scope: HealthScope,
  upstreamModels?: ReadonlyMap<string, string>,
): Promise<RouteAvailability<T>> {
  const checks = await mapWithConcurrency(
    routedProviders,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async ({ provider }): Promise<ProviderSelectionCheck> => {
      const health = applyHealthReadPolicy(
        provider,
        await getProviderAvailability(env, provider.id, scope),
      );
      return {
        provider_id: provider.id,
        ...health,
      };
    },
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
    }): Promise<CredentialSelectionCheck> => {
      let health = applyHealthReadPolicy(
        provider,
        await getCredentialAvailability(env, provider.id, key.id, scope),
      );
      const model = upstreamModels?.get(provider.id);
      if (provider.type === ProviderType.Antigravity) {
        if (health.available && key.auth.type === "oauth")
          health = await antigravityAccountAvailability(
            env,
            key.auth.account_ref,
          );
        if (
          health.available &&
          scope === HealthScope.Inference &&
          model &&
          key.auth.type === "oauth"
        )
          health = await antigravityModelAvailability(
            env,
            key.auth.account_ref,
            model,
          );
      }
      return { provider_id: provider.id, credential_id: key.id, ...health };
    },
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

export function credentialKey(
  providerId: string,
  credentialId: string,
): string {
  return `${providerId}\u0000${credentialId}`;
}

function withoutCredentials<T extends RoutedProvider>(
  candidates: T[],
  excluded: ReadonlySet<string> | undefined,
): T[] {
  if (!excluded?.size) return candidates;
  return candidates.flatMap((routed) => {
    const credentials = routed.credentials.filter(
      (credential) =>
        !excluded.has(credentialKey(routed.provider.id, credential.id)),
    );
    return credentials.length > 0 ? [{ ...routed, credentials }] : [];
  });
}

function usesRoundRobin(provider: ProviderConfig): boolean {
  return (
    "account_selection" in provider &&
    provider.account_selection === CodexAccountSelection.RoundRobin
  );
}

/**
 * The account a new binding should use. Native round robin rotates across the
 * top-priority accounts; everything else fills the first candidate. Session
 * bindings allocate their rotation inside the affinity object instead.
 */
async function preferredCandidate(
  env: Bindings,
  candidates: RoutedProvider[],
): Promise<AffinitySelection | undefined> {
  const selection = chooseAffinityCandidate(affinityCandidates(candidates));
  const routed =
    selection &&
    candidates.find(({ provider }) => provider.id === selection.provider_id);
  if (!selection || !routed || !usesRoundRobin(routed.provider))
    return selection;
  const priority = Math.max(
    ...routed.credentials.map((credential) => credential.priority),
  );
  const credentialId = await nextRotationCredential(
    env,
    routed.provider.id,
    routed.credentials
      .filter((credential) => credential.priority === priority)
      .map((credential) => credential.id),
    true,
  );
  return credentialId
    ? {
        provider_id: routed.provider.id,
        credential_id: credentialId,
      }
    : selection;
}

function affinityCandidates(
  candidates: RoutedProvider[],
): AffinityProviderCandidate[] {
  return candidates.map(({ provider, credentials }) => ({
    provider_id: provider.id,
    priority: provider.priority,
    supports_context_management: provider.supports_context_management,
    retain_available_account:
      provider.type === ProviderType.Codex ||
      provider.type === ProviderType.Antigravity ||
      provider.type === ProviderType.Claude ||
      provider.type === ProviderType.Xai,
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
  preferred: AffinitySelection | undefined,
): ProviderTarget | undefined {
  const selected =
    preferred ?? chooseAffinityCandidate(affinityCandidates(candidates));
  return selected
    ? targetByIds(candidates, selected.provider_id, selected.credential_id)
    : undefined;
}

export async function selectAvailableProviderWithDetails(
  env: Bindings,
  route: ModelRoute,
  options: ProviderSelectionOptions = {},
): Promise<ProviderSelection> {
  const quota =
    options.scope === HealthScope.Catalog || options.skipClaudeQuota
      ? { route, allBlocked: false, until: undefined }
      : await claudeQuotaRoute(
          env,
          route,
          options.excludedCredentials ?? new Set(),
        );
  const xai =
    options.scope === HealthScope.Catalog || options.skipXaiQuota
      ? { route: quota.route, allBlocked: false, until: undefined }
      : await xaiQuotaRoute(
          env,
          quota.route,
          options.excludedCredentials ?? new Set(),
        );
  const selection = await selectAvailableTargetWithDetails(
    env,
    xai.route.targets,
    {
      ...options,
      upstreamModels: new Map(
        route.targets.map((target) => [
          target.provider.id,
          target.upstreamModel,
        ]),
      ),
    },
  );
  const target = selection.target;
  const routed =
    target &&
    route.targets.find(({ provider }) => provider.id === target.provider.id);
  return {
    ...selection,
    xaiQuota: { allBlocked: xai.allBlocked, until: xai.until },
    claudeQuota: { allBlocked: quota.allBlocked, until: quota.until },
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
  env: Bindings,
  providers: RoutedProvider[],
  options: ProviderSelectionOptions = {},
): Promise<TargetSelection> {
  const contextManagement = options.contextManagement === true;
  const evaluated = await evaluateAvailability(
    env,
    contextManagement
      ? providers.filter(({ provider }) => provider.supports_context_management)
      : providers,
    options.scope ?? HealthScope.Inference,
    options.upstreamModels,
  );
  const availability = {
    ...evaluated,
    candidates: withoutCredentials(
      evaluated.candidates,
      options.excludedCredentials,
    ),
  };
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
      affinity: { status: SessionAffinityStatus.Blocked },
    };
  }
  if (options.session) {
    const candidates = affinityCandidates(availability.candidates);
    try {
      const identity = await sessionAffinityIdentity(
        options.session.clientId,
        options.session.sessionId,
      );
      const resolution = await env.SESSION_AFFINITY.getByName(
        identity.object_name,
      ).resolve(candidates, chooseAffinityCandidate(candidates), identity, {
        roundRobinProviderIds: availability.candidates
          .filter(({ provider }) => usesRoundRobin(provider))
          .map(({ provider }) => provider.id),
        contextManagement,
        ...(options.initialProviderIds === undefined
          ? {}
          : { initialProviderIds: options.initialProviderIds }),
      });
      if (!resolution) {
        throw new Error("session affinity returned no candidate");
      }
      if (resolution.status === SessionAffinityStatus.Blocked) {
        return {
          target: undefined,
          checks: availability.checks,
          credentialChecks: availability.credentialChecks,
          affinity: {
            status: SessionAffinityStatus.Blocked,
            provider_id: resolution.provider_id,
            credential_id: resolution.credential_id,
          },
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
            affinity: { status: SessionAffinityStatus.Forbidden },
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
        affinity: {
          status: SessionAffinityStatus.Failed,
          error: errorMessage(error),
        },
      };
    }
  }

  const preferred = await preferredCandidate(env, availability.candidates);
  return {
    target: selectTarget(availability.candidates, preferred),
    checks: availability.checks,
    credentialChecks: availability.credentialChecks,
  };
}

export async function selectAvailableProvider(
  env: Bindings,
  route: ModelRoute,
): Promise<ProviderConfig | undefined> {
  return (await selectAvailableProviderWithDetails(env, route)).target
    ?.provider;
}

export async function selectAvailableCatalogTargetsWithDetails(
  env: Bindings,
  routedProviders: RoutedProvider[],
): Promise<CatalogSelection> {
  const availability = await evaluateAvailability(
    env,
    routedProviders,
    HealthScope.Catalog,
  );
  const targets = availability.candidates.flatMap(
    ({ provider, credentials }) => {
      const credential = selectProviderCredential({ credentials });
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
  env: Bindings,
  route: ModelRoute,
  target: ModelProviderTarget,
  scope: HealthScope = HealthScope.Inference,
): Promise<boolean> {
  const routed = route.targets.find(
    ({ provider }) => provider.id === target.provider.id,
  );
  if (!routed?.credentials.some((key) => key.id === target.credential.id)) {
    return false;
  }
  const availability = await evaluateAvailability(
    env,
    [
      {
        ...routed,
        credentials: routed.credentials.filter(
          (key) => key.id === target.credential.id,
        ),
      },
    ],
    scope,
    new Map([[routed.provider.id, routed.upstreamModel]]),
  );
  return availability.candidates.length > 0;
}
