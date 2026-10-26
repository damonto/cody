import type { Bindings } from "../../platform/bindings.ts";
import type { ProviderAvailability } from "../../gateway/health/health.ts";
import { ProviderAvailabilityReason } from "../../gateway/health/values.ts";
import { errorMessage } from "../../shared/log.ts";
import { accountReply, accountReadinessSchema } from "./schema.ts";

export async function oauthAccountAvailability(
  env: Pick<Bindings, "PROVIDER_OAUTH_ACCOUNT">,
  accountRef: string,
): Promise<ProviderAvailability> {
  try {
    const { ready, codex_mode } = await accountReply(
      env.PROVIDER_OAUTH_ACCOUNT.getByName(accountRef).run({
        action: "readiness",
      }),
      accountReadinessSchema,
    );
    return {
      ...(codex_mode ? { codex_mode } : {}),
      available: ready,
      reason: ready
        ? ProviderAvailabilityReason.Available
        : ProviderAvailabilityReason.AccountNotReady,
    };
  } catch (error) {
    return {
      available: false,
      reason: ProviderAvailabilityReason.HealthReadFailed,
      error: errorMessage(error),
    };
  }
}
