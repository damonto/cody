import { SessionAffinityStatus } from "../../gateway/routing/values.ts";

import {
  HealthCooldownReason,
  ProviderAvailabilityReason,
} from "../../gateway/health/values.ts";
import { ProviderType } from "../../config/values.ts";

import type { GatewayConfig } from "../../config/types.ts";
import {
  credentialKey,
  type ProviderSelection,
  type RoutedProvider,
} from "../../gateway/routing/routing.ts";
import type { Bindings } from "../../platform/bindings.ts";
import { consumeCodexResetForExhaustion } from "./resets.ts";

/**
 * When every Codex account the request could use is cooling for quota, the
 * earliest reset; otherwise undefined.
 */
export function codexQuotaResetsAt(
  targets: readonly RoutedProvider[],
  selection: ProviderSelection,
  excluded: ReadonlySet<string>,
): number | undefined {
  const codex = targets.find(
    ({ provider }) => provider.type === ProviderType.Codex,
  );
  if (!codex) return undefined;
  let earliest: number | undefined;
  for (const credential of codex.credentials) {
    const check = selection.credentialChecks.find(
      (entry) =>
        entry.provider_id === codex.provider.id &&
        entry.credential_id === credential.id,
    );
    if (check?.reason === ProviderAvailabilityReason.RequestUnsupported)
      continue;
    if (
      check?.cooldown_reason !== HealthCooldownReason.Quota ||
      typeof check.cooling_until !== "number"
    ) {
      if (excluded.has(credentialKey(codex.provider.id, credential.id)))
        continue;
      return undefined;
    }
    earliest = Math.min(earliest ?? Infinity, check.cooling_until);
  }
  return earliest;
}

/**
 * With `auto_consume_resets`, spends one reset credit once every Codex account
 * is exhausted and readmits the restored account. Returns whether selection
 * should run again.
 */
export async function restoreCodexAccount(
  env: Bindings,
  config: GatewayConfig,
  targets: readonly RoutedProvider[],
  selection: ProviderSelection,
  excluded: Set<string>,
  exhausted: boolean,
  requestId: string,
): Promise<boolean> {
  const provider = targets.find(
    ({ provider }) => provider.type === ProviderType.Codex,
  )?.provider;
  if (
    provider?.type !== ProviderType.Codex ||
    !provider.auto_consume_resets ||
    selection.affinity?.status === SessionAffinityStatus.Failed ||
    [...selection.checks, ...selection.credentialChecks].some(
      (check) =>
        check.provider_id === provider.id &&
        check.reason === ProviderAvailabilityReason.HealthReadFailed,
    ) ||
    (!exhausted &&
      codexQuotaResetsAt(targets, selection, excluded) === undefined)
  )
    return false;
  const restored = await consumeCodexResetForExhaustion(
    env,
    config,
    {
      ...provider,
      credentials: provider.credentials.filter((credential) => {
        const check = selection.credentialChecks.find(
          (entry) =>
            entry.provider_id === provider.id &&
            entry.credential_id === credential.id,
        );
        return (
          check?.codex_mode !== "siwc" &&
          check?.reason !== ProviderAvailabilityReason.RequestUnsupported
        );
      }),
    },
    requestId,
  );
  if (!restored) return false;
  excluded.delete(credentialKey(provider.id, restored));
  return true;
}

/** Ignore credentials excluded by endpoint, request or the current attempt's mode. */
export function siwcOnlySelection(
  selection: Pick<ProviderSelection, "credentialChecks">,
): boolean {
  const compatible = selection.credentialChecks.filter(
    (check) => check.reason !== ProviderAvailabilityReason.RequestUnsupported,
  );
  return (
    compatible.length > 0 &&
    compatible.every((check) => check.codex_mode === "siwc")
  );
}
