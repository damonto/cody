import type { GatewayConfig } from "../../../../src/config/types";
import type { ModelPolicy } from "../../../../src/billing/types";

export function updatePolicy(
  config: GatewayConfig,
  policy: ModelPolicy,
): GatewayConfig {
  return {
    ...config,
    model_policies: [
      ...(config.model_policies ?? []).filter(
        (entry) =>
          entry.provider_id !== policy.provider_id ||
          entry.model !== policy.model,
      ),
      policy,
    ],
  };
}
