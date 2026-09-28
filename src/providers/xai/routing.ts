import { ProviderType, CredentialAuthType } from "../../config/values.ts";
import type { ModelRoute } from "../../gateway/routing/routing.ts";
import {
  getCredentialAvailability,
  getProviderAvailability,
} from "../../gateway/health/health.ts";
import { ProviderAvailabilityReason } from "../../gateway/health/values.ts";
import type { Bindings } from "../../platform/bindings.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import { accountReply, accountViewSchema } from "../oauth/schema.ts";
import { OAuthAccountViewStatus } from "../oauth/values.ts";
import { quotaAvailability } from "./limits.ts";

interface QuotaRoute {
  route: ModelRoute;
  allBlocked: boolean;
  until: number | undefined;
}

/** Subscription candidates always precede paid candidates, independent of priority. */
export async function xaiQuotaRoute(
  env: Bindings,
  route: ModelRoute,
  excluded: ReadonlySet<string>,
): Promise<QuotaRoute> {
  const target = route.targets.find(
    (target) => target.provider.type === ProviderType.Xai,
  );
  if (!target || target.provider.type !== ProviderType.Xai)
    return { route, allBlocked: false, until: undefined };
  const provider = target.provider;
  const providerHealth = await getProviderAvailability(env, provider.id);
  const checks = await mapWithConcurrency(
    target.credentials,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async (credential) => {
      if (
        !providerHealth.available ||
        providerHealth.reason === ProviderAvailabilityReason.HealthReadFailed ||
        credential.auth.type !== CredentialAuthType.OAuth ||
        excluded.has(`${provider.id}\u0000${credential.id}`)
      )
        return { credential };
      try {
        const health = await getCredentialAvailability(
          env,
          provider.id,
          credential.id,
        );
        if (
          !health.available ||
          health.reason === ProviderAvailabilityReason.HealthReadFailed
        )
          return { credential };
        const account = await accountReply(
          env.PROVIDER_OAUTH_ACCOUNT.getByName(credential.auth.account_ref).run(
            { action: "quota", force: false },
          ),
          accountViewSchema,
        );
        return account.status === OAuthAccountViewStatus.Ready
          ? {
              credential,
              availability: quotaAvailability(
                account.quota,
                target.upstreamModel,
              ),
            }
          : { credential };
      } catch {
        return { credential };
      }
    },
  );
  const subscription = checks.filter(
    (check) => check.availability?.subscription,
  );
  const allBlocked =
    checks.length > 0 && checks.every((check) => check.availability?.blocked);
  const selected = subscription.length
    ? subscription
    : provider.allow_extra_usage && allBlocked
      ? checks.filter((check) => check.availability?.extra)
      : [];
  const recoveryTimes = checks.flatMap((check) =>
    check.availability?.until === undefined ? [] : [check.availability.until],
  );
  return {
    route: {
      ...route,
      targets: route.targets.map((entry) =>
        entry === target
          ? { ...entry, credentials: selected.map((check) => check.credential) }
          : entry,
      ),
    },
    allBlocked,
    until:
      allBlocked && recoveryTimes.length
        ? Math.min(...recoveryTimes)
        : undefined,
  };
}
