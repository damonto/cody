import type { Bindings } from "../../platform/bindings.ts";
import type { ProviderAvailability } from "../../gateway/health/health.ts";
import {
  HealthCooldownReason,
  ProviderAvailabilityReason,
} from "../../gateway/health/values.ts";
import { errorMessage } from "../../shared/log.ts";
import type { AccountLimit } from "../types.ts";
import type {
  ModelRoute,
  ProviderSelection,
} from "../../gateway/routing/routing.ts";
import { ProviderType } from "../../config/values.ts";
import { apiError } from "../../gateway/http/http.ts";
import type { ApiProtocol } from "../../gateway/protocol-values.ts";

export function antigravityQuotaResetsAt(
  route: ModelRoute,
  selection: ProviderSelection,
): number | undefined {
  const provider = route.targets.find(
    (target) => target.provider.type === ProviderType.Antigravity,
  );
  if (
    !provider ||
    !selection.checks.find(
      (check) => check.provider_id === provider.provider.id,
    )?.available
  )
    return undefined;
  const checks = selection.credentialChecks.filter(
    (check) => check.provider_id === provider.provider.id,
  );
  if (
    !checks.length ||
    checks.some(
      (check) =>
        check.available ||
        check.cooldown_reason !== HealthCooldownReason.Quota ||
        !check.cooling_until,
    )
  )
    return undefined;
  return Math.min(...checks.map((check) => check.cooling_until!));
}

export function antigravityQuotaResponse(
  protocol: ApiProtocol,
  until: number,
  requestId: string,
): Response {
  const response = apiError(
    protocol,
    429,
    `All available Antigravity accounts are limited for this model until ${new Date(until).toISOString()}`,
    { code: "usage_limit_reached", requestId },
  );
  response.headers.set(
    "retry-after",
    String(Math.max(1, Math.ceil((until - Date.now()) / 1000))),
  );
  return response;
}

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
