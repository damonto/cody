import type {
  HealthCooldownReason,
  ProviderHealthSnapshot,
} from "../../config/types.ts";
import { configureLogging } from "../../shared/log.ts";
import {
  ProviderHealthState,
  type StoredProviderHealthState,
} from "./health.ts";
import type { Bindings } from "../../platform/bindings.ts";
import type { ObjectContext } from "../../platform/object-context.ts";

const HEALTH_STORAGE_KEY = "health";
const ROTATION_STORAGE_KEY = "rotation";
const LEASE_STORAGE_PREFIX = "lease:";

export interface ResetOperation {
  credential_id: string;
  account_ref: string;
  credit_id: string;
  redeem_request_id: string;
  cooling_until: number;
}
export interface LeaseGrant {
  owner: string;
  operation: ResetOperation | null;
}
interface StoredLease extends LeaseGrant {
  until: number;
}

function storedStatesEqual(
  left: StoredProviderHealthState | undefined,
  right: StoredProviderHealthState | null,
): boolean {
  if (left === undefined || right === null) {
    return left === undefined && right === null;
  }
  return (
    left.failures === right.failures &&
    left.failure_window_started_at === right.failure_window_started_at &&
    left.cooling_until === right.cooling_until &&
    (left.reason ?? null) === (right.reason ?? null)
  );
}

export class ProviderHealthCore {
  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: Bindings,
  ) {
    configureLogging(this.env.LOG_LEVEL);
  }

  private async load(): Promise<{
    health: ProviderHealthState;
    stored: StoredProviderHealthState | undefined;
  }> {
    const stored =
      await this.ctx.storage.get<StoredProviderHealthState>(HEALTH_STORAGE_KEY);
    return {
      health: new ProviderHealthState(undefined, stored),
      stored,
    };
  }

  private async persist(
    previous: StoredProviderHealthState | undefined,
    next: StoredProviderHealthState | null,
  ): Promise<void> {
    if (storedStatesEqual(previous, next)) {
      return;
    }
    if (next === null) {
      await this.ctx.storage.delete(HEALTH_STORAGE_KEY);
    } else {
      await this.ctx.storage.put(HEALTH_STORAGE_KEY, next);
    }
  }

  async getStatus(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.getStatus();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordSuccess(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordSuccess();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordFailure(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordFailure();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordImmediateFailure(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordImmediateFailure();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordCooldownUntil(
    until: number,
    reason: HealthCooldownReason,
  ): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordCooldownUntil(until, reason);
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  /** The ID after the last pick, so rotation survives list edits. */
  async rotate(ids: string[], advance: boolean): Promise<string | null> {
    if (ids.length === 0) return null;
    return this.ctx.storage.transaction(async (tx) => {
      const last = await tx.get<string>(ROTATION_STORAGE_KEY);
      const index = last === undefined ? -1 : ids.indexOf(last);
      const next = ids[(index + 1) % ids.length] ?? null;
      if (advance && next !== null) await tx.put(ROTATION_STORAGE_KEY, next);
      return next;
    });
  }

  async claimLease(name: string, ttlMs: number): Promise<LeaseGrant | null> {
    const key = `${LEASE_STORAGE_PREFIX}${name}`;
    return this.ctx.storage.transaction(async (tx) => {
      const previous = await tx.get<StoredLease>(key);
      if (previous && previous.until > Date.now()) return null;
      const lease: StoredLease = {
        owner: crypto.randomUUID(),
        until: Date.now() + ttlMs,
        operation: previous?.operation ?? null,
      };
      await tx.put(key, lease);
      return { owner: lease.owner, operation: lease.operation };
    });
  }

  /** Persist the idempotency key before any paid operation can start. */
  async prepareResetLease(
    name: string,
    owner: string,
    operation: ResetOperation,
    ttlMs: number,
  ): Promise<ResetOperation | null> {
    const key = `${LEASE_STORAGE_PREFIX}${name}`;
    return this.ctx.storage.transaction(async (tx) => {
      const lease = await tx.get<StoredLease>(key);
      if (!lease || lease.owner !== owner || lease.until <= Date.now())
        return null;
      const pending = lease.operation ?? operation;
      await tx.put(key, {
        ...lease,
        operation: pending,
        until: Date.now() + ttlMs,
      });
      return pending;
    });
  }

  /** Late completions cannot release a newer owner or forget its pending reset. */
  async releaseLease(
    name: string,
    owner: string,
    holdMs: number,
    completed: boolean,
  ): Promise<void> {
    const key = `${LEASE_STORAGE_PREFIX}${name}`;
    await this.ctx.storage.transaction(async (tx) => {
      const lease = await tx.get<StoredLease>(key);
      if (!lease || lease.owner !== owner) return;
      const operation = completed ? null : lease.operation;
      if (holdMs > 0 || operation)
        await tx.put(key, { ...lease, operation, until: Date.now() + holdMs });
      else await tx.delete(key);
    });
  }

  async clearQuotaCooldownUntil(until: number): Promise<boolean> {
    return this.ctx.storage.transaction(async (tx) => {
      const stored =
        await tx.get<StoredProviderHealthState>(HEALTH_STORAGE_KEY);
      if (
        !stored ||
        stored.cooling_until === null ||
        stored.cooling_until <= Date.now()
      )
        return true;
      if (stored.reason !== "quota" || stored.cooling_until !== until)
        return false;
      await tx.delete(HEALTH_STORAGE_KEY);
      return true;
    });
  }

  async clear(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.clear();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }
}
