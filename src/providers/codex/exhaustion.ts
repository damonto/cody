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
  const codex = targets.find(({ provider }) => provider.type === "codex");
  if (!codex) return undefined;
  let earliest: number | undefined;
  for (const credential of codex.credentials) {
    const check = selection.credentialChecks.find(
      (entry) =>
        entry.provider_id === codex.provider.id &&
        entry.credential_id === credential.id,
    );
    if (
      check?.cooldown_reason !== "quota" ||
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
 * When a blocked session binding waits on an account cooling for quota, that
 * account's reset. Context history lives on the bound account, so such a
 * session waits instead of moving.
 */
export function blockedCodexQuotaResetsAt(
  selection: ProviderSelection,
): number | undefined {
  if (selection.affinity?.status !== "blocked") return undefined;
  const bound = selection.credentialChecks.find(
    (check) =>
      check.provider_id === selection.affinity?.provider_id &&
      check.credential_id === selection.affinity.credential_id,
  );
  return bound?.cooldown_reason === "quota" &&
    typeof bound.cooling_until === "number"
    ? bound.cooling_until
    : undefined;
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
    ({ provider }) => provider.type === "codex",
  )?.provider;
  if (
    provider?.type !== "codex" ||
    !provider.auto_consume_resets ||
    selection.affinity?.status === "blocked" ||
    (!exhausted &&
      codexQuotaResetsAt(targets, selection, excluded) === undefined)
  )
    return false;
  const restored = await consumeCodexResetForExhaustion(
    env,
    config,
    provider,
    requestId,
  );
  if (!restored) return false;
  excluded.delete(credentialKey(provider.id, restored));
  return true;
}
