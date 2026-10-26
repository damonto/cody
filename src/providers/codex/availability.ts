import type { ProviderAvailability } from "../../gateway/health/health.ts";
import { ProviderAvailabilityReason } from "../../gateway/health/values.ts";
import { ProviderRequestError } from "../errors.ts";
import { validateSiwcRequest, type CodexRequestPolicy } from "./siwc-policy.ts";

/** Account mode is considered before selection, independently of token resolution. */
export function codexRequestAvailability(
  health: ProviderAvailability,
  request: CodexRequestPolicy,
): ProviderAvailability {
  if (health.reason === ProviderAvailabilityReason.HealthReadFailed)
    return health;
  const mode = health.codex_mode ?? "native";
  if (request.mode && request.mode !== mode)
    return {
      ...health,
      available: false,
      reason: ProviderAvailabilityReason.RequestUnsupported,
    };
  if (mode !== "siwc") return health;
  try {
    validateSiwcRequest(request);
    return health;
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    return {
      ...health,
      available: false,
      reason: ProviderAvailabilityReason.RequestUnsupported,
      request_error: {
        message: error.message,
        code: error.code,
        ...(error.param ? { param: error.param } : {}),
      },
    };
  }
}
