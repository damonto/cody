import type { ProxyStrategy } from "../../config/types.ts";
import type { ProxyOutcome, StoredProxyHealth } from "./schema.ts";

export const PROXY_FAILURE_THRESHOLD = 3;
export const PROXY_FAILURE_WINDOW_MS = 60_000;
export const PROXY_COOLDOWN_MS = 5 * 60_000;

export function freshProxyHealth(): StoredProxyHealth {
  return {
    generation: crypto.randomUUID(),
    failures: [],
    last_success_at: null,
    cooling_until: null,
  };
}

export function currentProxyHealth(
  health: StoredProxyHealth,
  now: number,
): StoredProxyHealth {
  if (health.cooling_until !== null) {
    return now >= health.cooling_until ? freshProxyHealth() : health;
  }
  return {
    ...health,
    failures: health.failures.filter(
      (failure) => now - failure.at < PROXY_FAILURE_WINDOW_MS,
    ),
  };
}

/** Completion timestamps keep delayed background reports from erasing newer failures. */
export function observeProxyHealth(
  previous: StoredProxyHealth,
  event: ProxyOutcome,
  now: number,
): StoredProxyHealth {
  const health = currentProxyHealth(previous, now);
  if (
    health.generation !== event.lease.generation ||
    health.cooling_until !== null
  ) {
    return health;
  }
  const at = Math.min(now, event.observed_at);
  if (event.outcome === "success") {
    const lastSuccess = Math.max(health.last_success_at ?? 0, at);
    return {
      ...health,
      last_success_at: lastSuccess,
      failures: health.failures.filter((failure) => failure.at > lastSuccess),
    };
  }
  if (
    now - at >= PROXY_FAILURE_WINDOW_MS ||
    at <= (health.last_success_at ?? -1) ||
    health.failures.some((failure) => failure.id === event.event_id)
  ) {
    return health;
  }
  const failures = [...health.failures, { id: event.event_id, at }].sort(
    (a, b) => a.at - b.at,
  );
  if (failures.length >= PROXY_FAILURE_THRESHOLD) {
    // All outstanding leases become stale. A late success cannot end this cooldown.
    return {
      ...health,
      failures,
      generation: crypto.randomUUID(),
      cooling_until: now + PROXY_COOLDOWN_MS,
    };
  }
  return { ...health, failures };
}

export function chooseProxy<T extends { priority: number }>(
  candidates: readonly T[],
  strategy: ProxyStrategy,
  random: () => number = Math.random,
): T | undefined {
  if (!candidates.length) {
    return undefined;
  }
  const priority =
    strategy === "priority"
      ? Math.max(...candidates.map((candidate) => candidate.priority))
      : undefined;
  const eligible =
    priority === undefined
      ? candidates
      : candidates.filter((candidate) => candidate.priority === priority);
  return eligible[Math.floor(random() * eligible.length)];
}
