import { DurableObject } from "cloudflare:workers";

import {
  ProviderHealthState,
  type StoredProviderHealthState,
} from "./health.ts";
import { configureLogging } from "../../shared/log.ts";
import type { ProviderHealthSnapshot } from "../../config/types.ts";

const HEALTH_STORAGE_KEY = "health";

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
    left.cooling_until === right.cooling_until
  );
}

export class ProviderHealth extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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

  async clear(): Promise<ProviderHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.clear();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }
}
