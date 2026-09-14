import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import { errorMessage, logWarn } from "../../shared/log.ts";
import { isAnthropicProtocol, type ApiProtocol } from "../protocol.ts";
import type {
  ProviderConfig,
  ProviderHealthSnapshot,
} from "../../config/types.ts";

export const FAILURE_THRESHOLD = 10;
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;

/** Which health record an upstream status produces. */
export type HealthFailureScope = "provider" | "credential";

// One map per protocol rather than a provider set plus a key set: a status can
// only appear once, so recording both a provider and a key failure for the same
// response is unrepresentable instead of merely unlikely.
//
// OpenAI-compatible upstreams: 400 and 503 mean the provider is unhealthy, while
// 402 (billing) and 403 (forbidden) are specific to the key used.
const OPENAI_FAILURE_SCOPES = new Map<number, HealthFailureScope>([
  [400, "provider"],
  [402, "credential"],
  [403, "credential"],
  [503, "provider"],
]);

// Anthropic upstreams signal an unhealthy provider with 5xx statuses: 529 is
// their documented overload code, and real gateways in front of them return
// 500/502/503 for the same condition. 401 is an invalid key and 403 is a key
// without access. The failure streak threshold keeps an isolated 5xx from
// cooling the provider down.
const ANTHROPIC_FAILURE_SCOPES = new Map<number, HealthFailureScope>([
  [401, "credential"],
  [403, "credential"],
  [500, "provider"],
  [502, "provider"],
  [503, "provider"],
  [529, "provider"],
]);

/**
 * Resolves the health record an upstream status produces, or `undefined` when
 * the status is not counted against health at all.
 */
export function healthFailureScope(
  status: number,
  protocol: ApiProtocol,
): HealthFailureScope | undefined {
  return (
    isAnthropicProtocol(protocol)
      ? ANTHROPIC_FAILURE_SCOPES
      : OPENAI_FAILURE_SCOPES
  ).get(status);
}

export type HealthScope = "inference" | "catalog";

export interface HealthExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface StoredProviderHealthState {
  failures: number;
  failure_window_started_at: number | null;
  cooling_until: number | null;
}

export interface CoolingProviderHealth extends ProviderHealthSnapshot {
  provider_id: string;
}

interface CoolingCredentialHealth extends ProviderHealthSnapshot {
  provider_id: string;
  credential_id: string;
}

export type CoolingHealth = CoolingProviderHealth | CoolingCredentialHealth;

type ProviderAvailabilityReason =
  "available" | "cooling" | "health_read_failed";

export interface ProviderAvailability {
  available: boolean;
  reason: ProviderAvailabilityReason;
  failures?: number;
  cooling_until?: number | null;
  error?: string;
}

export class ProviderHealthState {
  private failures = 0;
  private failureWindowStartedAt: number | null = null;
  private coolingUntil: number | null = null;

  constructor(
    private readonly clock: () => number = () => Date.now(),
    stored?: StoredProviderHealthState,
  ) {
    if (stored) {
      this.failures = stored.failures;
      this.failureWindowStartedAt = stored.failure_window_started_at;
      this.coolingUntil = stored.cooling_until;
    }
  }

  private resetFailures(): void {
    this.failures = 0;
    this.failureWindowStartedAt = null;
  }

  private snapshot(now = this.clock()): ProviderHealthSnapshot {
    if (this.coolingUntil !== null && now >= this.coolingUntil) {
      this.resetFailures();
      this.coolingUntil = null;
    }
    if (
      this.coolingUntil === null &&
      this.failureWindowStartedAt !== null &&
      now - this.failureWindowStartedAt >= FAILURE_WINDOW_MS
    ) {
      this.resetFailures();
    }
    return {
      failures: this.failures,
      cooling_until: this.coolingUntil,
    };
  }

  getStatus(): ProviderHealthSnapshot {
    const now = this.clock();
    return this.snapshot(now);
  }

  getStoredState(): StoredProviderHealthState | null {
    if (
      this.failures === 0 &&
      this.failureWindowStartedAt === null &&
      this.coolingUntil === null
    ) {
      return null;
    }
    return {
      failures: this.failures,
      failure_window_started_at: this.failureWindowStartedAt,
      cooling_until: this.coolingUntil,
    };
  }

  clear(): ProviderHealthSnapshot {
    this.resetFailures();
    this.coolingUntil = null;
    return this.snapshot();
  }

  recordSuccess(): ProviderHealthSnapshot {
    return this.clear();
  }

  recordFailure(): ProviderHealthSnapshot {
    const now = this.clock();
    this.snapshot(now);
    if (this.coolingUntil === null) {
      if (
        this.failureWindowStartedAt === null ||
        now - this.failureWindowStartedAt >= FAILURE_WINDOW_MS
      ) {
        this.resetFailures();
        this.failureWindowStartedAt = now;
      }
      this.failures += 1;
      if (this.failures >= FAILURE_THRESHOLD) {
        this.coolingUntil = now + COOLDOWN_MS;
      }
    }
    return this.snapshot(now);
  }

  recordImmediateFailure(): ProviderHealthSnapshot {
    const now = this.clock();
    this.snapshot(now);
    if (this.coolingUntil === null) {
      if (
        this.failureWindowStartedAt === null ||
        now - this.failureWindowStartedAt >= FAILURE_WINDOW_MS
      ) {
        this.resetFailures();
        this.failureWindowStartedAt = now;
      }
      this.failures += 1;
    }
    this.coolingUntil = now + COOLDOWN_MS;
    return this.snapshot(now);
  }
}

function healthObjectName(providerId: string, scope: HealthScope): string {
  return scope === "inference" ? providerId : `${providerId}:catalog`;
}

function healthStub(env: Env, providerId: string, scope: HealthScope) {
  return env.HEALTH.getByName(healthObjectName(providerId, scope));
}

function credentialHealthObjectName(
  providerId: string,
  credentialId: string,
  scope: HealthScope,
): string {
  const base = `key:${providerId}:${credentialId}`;
  return scope === "inference" ? base : `${base}:catalog`;
}

function credentialHealthStub(
  env: Env,
  providerId: string,
  credentialId: string,
  scope: HealthScope,
) {
  return env.HEALTH.getByName(
    credentialHealthObjectName(providerId, credentialId, scope),
  );
}

export async function getProviderAvailability(
  env: Env,
  providerId: string,
  scope: HealthScope = "inference",
): Promise<ProviderAvailability> {
  try {
    const snapshot = await healthStub(env, providerId, scope).getStatus();
    const available =
      snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    return {
      available,
      reason: available ? "available" : "cooling",
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    };
  } catch (error) {
    return {
      available: true,
      reason: "health_read_failed",
      error: errorMessage(error),
    };
  }
}

export async function providerIsAvailable(
  env: Env,
  providerId: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  return (await getProviderAvailability(env, providerId, scope)).available;
}

export async function getCredentialAvailability(
  env: Env,
  providerId: string,
  credentialId: string,
  scope: HealthScope = "inference",
): Promise<ProviderAvailability> {
  try {
    const snapshot = await credentialHealthStub(
      env,
      providerId,
      credentialId,
      scope,
    ).getStatus();
    const available =
      snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    return {
      available,
      reason: available ? "available" : "cooling",
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    };
  } catch (error) {
    return {
      available: true,
      reason: "health_read_failed",
      error: errorMessage(error),
    };
  }
}

export async function credentialIsAvailable(
  env: Env,
  providerId: string,
  credentialId: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  return (await getCredentialAvailability(env, providerId, credentialId, scope))
    .available;
}

async function record(
  env: Env,
  providerId: string,
  outcome: "success" | "failure",
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  try {
    const stub = healthStub(env, providerId, scope);
    const snapshot =
      outcome === "success"
        ? await stub.recordSuccess()
        : await stub.recordFailure();
    if (outcome === "failure" && snapshot.cooling_until !== null) {
      logWarn("health.cooldown.active", {
        request_id: requestId,
        provider_id: providerId,
        scope,
        failures: snapshot.failures,
        cooling_until: snapshot.cooling_until,
      });
    }
  } catch (error) {
    logWarn("health.update.failed", {
      request_id: requestId,
      provider_id: providerId,
      scope,
      outcome,
      error: errorMessage(error),
    });
  }
}

export function recordProviderSuccess(
  env: Env,
  providerId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  return record(env, providerId, "success", requestId, scope);
}

export function recordProviderFailure(
  env: Env,
  providerId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  return record(env, providerId, "failure", requestId, scope);
}

export async function recordCredentialFailure(
  env: Env,
  providerId: string,
  credentialId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  try {
    const snapshot = await credentialHealthStub(
      env,
      providerId,
      credentialId,
      scope,
    ).recordImmediateFailure();
    logWarn("health.credential_cooldown.active", {
      request_id: requestId,
      provider_id: providerId,
      credential_id: credentialId,
      scope,
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    });
  } catch (error) {
    logWarn("health.key_update.failed", {
      request_id: requestId,
      provider_id: providerId,
      credential_id: credentialId,
      scope,
      error: errorMessage(error),
    });
  }
}

export async function clearProviderHealth(
  env: Env,
  providerId: string,
  scope: HealthScope = "inference",
): Promise<ProviderHealthSnapshot> {
  const snapshot = await healthStub(env, providerId, scope).clear();
  return snapshot;
}

export async function clearCredentialHealth(
  env: Env,
  providerId: string,
  credentialId: string,
  scope: HealthScope = "inference",
): Promise<ProviderHealthSnapshot> {
  return credentialHealthStub(env, providerId, credentialId, scope).clear();
}

export async function listCoolingProviders(
  env: Env,
  providerIds: string[],
  scope: HealthScope = "inference",
): Promise<CoolingProviderHealth[]> {
  const statuses = await mapWithConcurrency(
    providerIds,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async (providerId) => ({
      provider_id: providerId,
      ...(await healthStub(env, providerId, scope).getStatus()),
    }),
  );
  const now = Date.now();
  return statuses.filter(
    (status) => status.cooling_until !== null && status.cooling_until > now,
  );
}

export async function listCoolingHealth(
  env: Env,
  providers: ProviderConfig[],
  scope: HealthScope = "inference",
): Promise<CoolingHealth[]> {
  const descriptors = providers.flatMap((provider) => [
    { kind: "provider" as const, provider_id: provider.id },
    ...provider.credentials.map((key) => ({
      kind: "credential" as const,
      provider_id: provider.id,
      credential_id: key.id,
    })),
  ]);
  const statuses = await mapWithConcurrency(
    descriptors,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async (descriptor): Promise<CoolingHealth> => {
      const snapshot =
        descriptor.kind === "provider"
          ? await healthStub(env, descriptor.provider_id, scope).getStatus()
          : await credentialHealthStub(
              env,
              descriptor.provider_id,
              descriptor.credential_id,
              scope,
            ).getStatus();
      return descriptor.kind === "provider"
        ? { provider_id: descriptor.provider_id, ...snapshot }
        : {
            provider_id: descriptor.provider_id,
            credential_id: descriptor.credential_id,
            ...snapshot,
          };
    },
  );
  const now = Date.now();
  return statuses.filter(
    (status) => status.cooling_until !== null && status.cooling_until > now,
  );
}

export function scheduleHealthUpdate(
  context: HealthExecutionContext | undefined,
  update: Promise<void>,
): Promise<void> {
  if (typeof context?.waitUntil === "function") {
    try {
      context.waitUntil(update);
      return Promise.resolve();
    } catch {
      return update;
    }
  }
  return update;
}
