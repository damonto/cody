import { xaiQuotaResponse } from "../../providers/xai/availability.ts";

import {
  antigravityQuotaResetsAt,
  antigravityQuotaResponse,
} from "../../providers/antigravity/exhaustion.ts";

import { ProviderAvailabilityReason } from "../health/values.ts";
import { SessionAffinityStatus } from "../routing/values.ts";

import { ProviderType } from "../../config/values.ts";

import type { Bindings } from "../../platform/bindings.ts";
import type { GatewayConfig } from "../../config/types.ts";

import { type RequestLogContext } from "../../shared/log.ts";
import type { RequestMeter } from "../../telemetry/meter.ts";

import {
  codexUsageLimitResponse,
  siwcUsageLimitResponse,
} from "../../providers/codex/limits.ts";
import {
  codexQuotaResetsAt,
  restoreCodexAccount,
  siwcOnlySelection,
} from "../../providers/codex/exhaustion.ts";

import { discardBody } from "./body.ts";

import { apiError } from "./http.ts";

import type { ModelRoute, ProviderSelection } from "../routing/routing.ts";
import type { ApiProtocol } from "../protocol.ts";

interface UnavailableInference {
  env: Bindings;
  config: GatewayConfig;
  route: ModelRoute;
  routeForSelection: ModelRoute;
  selection: ProviderSelection;
  excludedCredentials: Set<string>;
  exhausted: Response | undefined;
  resetConsumed: boolean;
  protocol: ApiProtocol;
  model: string;
  requestId: string;
  requestLog: RequestLogContext | undefined;
  meter: RequestMeter | undefined;
}

/** A null response means one reset restored an account; the caller may select again. */
export async function unavailableInference({
  env,
  config,
  route,
  routeForSelection,
  selection,
  excludedCredentials,
  exhausted,
  resetConsumed,
  protocol,
  model,
  requestId,
  requestLog,
  meter,
}: UnavailableInference): Promise<Response | null> {
  const claude = selection.claudeQuota;
  if (selection.affinity?.status === SessionAffinityStatus.Failed) {
    if (exhausted) await discardBody(exhausted.body);
    return apiError(protocol, 503, "The session binding store is unavailable", {
      type: "server_error",
      code: "session_affinity_unavailable",
      requestId,
    });
  }
  if (
    [...selection.checks, ...selection.credentialChecks].some(
      (check) =>
        config.providers.some(
          (provider) =>
            provider.id === check.provider_id &&
            (provider.type === ProviderType.Antigravity ||
              provider.type === ProviderType.Codex),
        ) && check.reason === ProviderAvailabilityReason.HealthReadFailed,
    )
  ) {
    if (exhausted) await discardBody(exhausted.body);
    meter?.diagnostic("quota_state_unavailable");
    return apiError(protocol, 503, "The account quota store is unavailable", {
      code: "quota_state_unavailable",
      requestId,
    });
  }
  const antigravityReset = antigravityQuotaResetsAt(
    routeForSelection,
    selection,
  );
  if (antigravityReset !== undefined) {
    if (exhausted) await discardBody(exhausted.body);
    meter?.diagnostic("usage_limit_reached");
    return antigravityQuotaResponse(protocol, antigravityReset, requestId);
  }
  const siwcOnly = siwcOnlySelection(selection);
  if (!resetConsumed && !siwcOnly) {
    if (
      await restoreCodexAccount(
        env,
        config,
        route.targets,
        selection,
        excludedCredentials,
        exhausted !== undefined,
        requestId,
      )
    )
      return null;
  }
  if (exhausted) {
    requestLog?.warn({ outcome: "accounts_exhausted" });
    meter?.diagnostic("usage_limit_reached");
    return exhausted;
  }
  if (selection.xaiQuota?.allBlocked)
    return xaiQuotaResponse(protocol, selection.xaiQuota.until, requestId);
  if (claude?.allBlocked) {
    const response = apiError(
      protocol,
      429,
      `Claude subscription quota exhausted${claude.until ? ` until ${new Date(claude.until).toISOString()}` : ""}`,
      { code: "usage_limit_reached", requestId },
    );
    if (claude.until)
      response.headers.set(
        "retry-after",
        String(Math.max(1, Math.ceil((claude.until - Date.now()) / 1000))),
      );
    return response;
  }
  const requestError = selection.credentialChecks.find(
    (check) => check.request_error,
  )?.request_error;
  if (
    requestError &&
    !selection.credentialChecks.some(
      (check) => check.reason !== ProviderAvailabilityReason.RequestUnsupported,
    )
  )
    return apiError(protocol, 400, requestError.message, {
      ...requestError,
      requestId,
    });
  const quotaResetsAt = codexQuotaResetsAt(
    route.targets,
    selection,
    excludedCredentials,
  );
  if (quotaResetsAt !== undefined) {
    requestLog?.warn({ outcome: "usage_limit_reached" });
    meter?.diagnostic("usage_limit_reached");
    return siwcOnly
      ? siwcUsageLimitResponse(requestId)
      : codexUsageLimitResponse(quotaResetsAt, requestId);
  }
  requestLog?.warn({ outcome: "provider_cooling_down" });
  return apiError(
    protocol,
    503,
    `No healthy provider is currently available for model ${model}`,
    { type: "server_error", code: "provider_cooling_down", requestId },
  );
}
