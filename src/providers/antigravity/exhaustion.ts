import { ProviderType } from "../../config/values.ts";
import { HealthCooldownReason } from "../../gateway/health/values.ts";
import { apiError } from "../../gateway/http/http.ts";
import type { ApiProtocol } from "../../gateway/protocol-values.ts";
import type {
  ModelRoute,
  ProviderSelection,
} from "../../gateway/routing/routing.ts";

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
  if (!checks.length) return undefined;
  let earliest = Infinity;
  for (const check of checks) {
    if (
      check.available ||
      check.cooldown_reason !== HealthCooldownReason.Quota ||
      check.cooling_until == null
    )
      return undefined;
    earliest = Math.min(earliest, check.cooling_until);
  }
  return earliest;
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
