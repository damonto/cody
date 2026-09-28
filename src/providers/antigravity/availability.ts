import type { Bindings } from "../../platform/bindings.ts";
import type { ProviderAvailability } from "../../gateway/health/health.ts";
import {
  HealthCooldownReason,
  ProviderAvailabilityReason,
} from "../../gateway/health/values.ts";
import { errorMessage } from "../../shared/log.ts";
import type { AccountLimit } from "../types.ts";

/** Physical account and real model, independent of editable credential IDs/aliases. */
export function antigravityQuotaObjectName(
  accountRef: string,
  model: string,
): string {
  return `quota:antigravity:${accountRef}:${encodeURIComponent(model)}`;
}

export async function antigravityModelAvailability(
  env: Pick<Bindings, "HEALTH">,
  accountRef: string,
  model: string,
): Promise<ProviderAvailability> {
  try {
    const snapshot = await env.HEALTH.getByName(
      antigravityQuotaObjectName(accountRef, model),
    ).getStatus();
    const available =
      snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    return {
      available,
      reason: available
        ? ProviderAvailabilityReason.Available
        : ProviderAvailabilityReason.Cooling,
      cooling_until: snapshot.cooling_until,
      ...(!available ? { cooldown_reason: HealthCooldownReason.Quota } : {}),
    };
  } catch (error) {
    return {
      available: false,
      reason: ProviderAvailabilityReason.HealthReadFailed,
      error: errorMessage(error),
    };
  }
}

export async function recordAntigravityLimit(
  env: Pick<Bindings, "HEALTH">,
  accountRef: string,
  model: string,
  limit: AccountLimit,
): Promise<void> {
  await env.HEALTH.getByName(
    antigravityQuotaObjectName(accountRef, model),
  ).recordCooldownUntil(limit.resets_at, HealthCooldownReason.Quota);
}
