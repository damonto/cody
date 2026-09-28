import { HealthCooldownReason } from "../../gateway/health/values.ts";
import { ConsumeResetCode } from "../oauth/values.ts";

import type { CodexProviderConfig, GatewayConfig } from "../../config/types.ts";
import {
  claimProviderLease,
  clearCredentialQuotaCooldownUntil,
  getCredentialAvailability,
  releaseProviderLease,
  prepareProviderResetLease,
} from "../../gateway/health/health.ts";
import type { Bindings } from "../../platform/bindings.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import { errorMessage, logWarn } from "../../shared/log.ts";
import {
  accountReply,
  accountViewSchema,
  consumeResetReplySchema,
} from "../oauth/schema.ts";
import { creditAvailable } from "./api.ts";

const RESET_LEASE = "codex-reset";
/** Bounds preparation of a spend; pending operations survive lease expiry. */
const RESET_LEASE_MS = 60_000;
/** After a failed automatic reset, wait before spending another attempt. */
const RESET_FAILURE_HOLD_MS = 5 * 60_000;

interface ResetCandidate {
  credential_id: string;
  account_ref: string;
  credit_id: string;
  expires_at: number;
  cooling_until: number;
}

/**
 * Spends one reset credit when every Codex account is out of quota. Only one
 * gateway request spends a credit at a time, and it picks the credit that
 * expires first across the accounts cooling for quota. Returns the credential
 * whose cooldown was cleared, or undefined when nothing was reset.
 */
export async function consumeCodexResetForExhaustion(
  env: Bindings,
  config: GatewayConfig,
  provider: CodexProviderConfig,
  requestId: string,
): Promise<string | undefined> {
  // Discovery may include token refreshes across many accounts. It runs before
  // the short spending lease; no paid operation takes place during discovery.
  let candidates: ResetCandidate[];
  try {
    candidates = (
      await mapWithConcurrency(
        provider.credentials.filter((credential) => !credential.disabled),
        PROVIDER_FAN_OUT_CONCURRENCY,
        async (credential): Promise<ResetCandidate[]> => {
          const health = await getCredentialAvailability(
            env,
            provider.id,
            credential.id,
          );
          const coolingUntil = health.cooling_until;
          if (
            health.cooldown_reason !== HealthCooldownReason.Quota ||
            typeof coolingUntil !== "number"
          )
            return [];
          const account = await accountReply(
            env.PROVIDER_OAUTH_ACCOUNT.getByName(
              credential.auth.account_ref,
            ).run({ action: "reset_credits" }),
            accountViewSchema,
          ).catch(() => undefined);
          if (account?.quota.reset_credits?.error) return [];
          return (account?.quota.reset_credits?.credits ?? []).flatMap(
            (credit) =>
              !creditAvailable(credit)
                ? []
                : [
                    {
                      credential_id: credential.id,
                      account_ref: credential.auth.account_ref,
                      credit_id: credit.id,
                      cooling_until: coolingUntil,
                      expires_at: credit.expires_at
                        ? Date.parse(credit.expires_at) || Infinity
                        : Infinity,
                    },
                  ],
          );
        },
      )
    ).flat();
  } catch (error) {
    logWarn("codex.reset.discovery_failed", {
      request_id: requestId,
      error: errorMessage(error),
    });
    return undefined;
  }
  const lease = await claimProviderLease(
    env,
    provider.id,
    RESET_LEASE,
    RESET_LEASE_MS,
  ).catch(() => null);
  if (!lease) return undefined;
  let holdMs = RESET_FAILURE_HOLD_MS;
  let completed = false;
  try {
    let operation = lease.operation;
    if (!operation) {
      // Another request or a manual reset may have restored an account while
      // discovery ran. Never spend based only on that earlier health snapshot.
      for (const credential of provider.credentials.filter(
        (entry) => !entry.disabled,
      )) {
        const health = await getCredentialAvailability(
          env,
          provider.id,
          credential.id,
        );
        if (health.cooldown_reason !== HealthCooldownReason.Quota) {
          holdMs = 0;
          return undefined;
        }
      }
      const chosen = candidates
        .filter((candidate) => candidate.expires_at > Date.now())
        .sort((left, right) => left.expires_at - right.expires_at)[0];
      if (!chosen) return undefined;
      operation = {
        credential_id: chosen.credential_id,
        account_ref: chosen.account_ref,
        credit_id: chosen.credit_id,
        redeem_request_id: crypto.randomUUID(),
        cooling_until: chosen.cooling_until,
      };
    }
    if (
      !provider.credentials.some(
        (credential) =>
          !credential.disabled &&
          credential.id === operation.credential_id &&
          credential.auth.account_ref === operation.account_ref,
      )
    )
      return undefined;
    const pending = await prepareProviderResetLease(
      env,
      provider.id,
      RESET_LEASE,
      lease.owner,
      operation,
      RESET_LEASE_MS,
    );
    if (!pending) return undefined;
    const reply = await accountReply(
      env.PROVIDER_OAUTH_ACCOUNT.getByName(pending.account_ref).run({
        action: "consume_reset",
        redeem_request_id: pending.redeem_request_id,
        credit_id: pending.credit_id,
      }),
      consumeResetReplySchema,
    );
    // A delayed result must not clear health or complete a newer owner's operation.
    if (
      !(await prepareProviderResetLease(
        env,
        provider.id,
        RESET_LEASE,
        lease.owner,
        pending,
        RESET_LEASE_MS,
      ))
    )
      return undefined;
    logWarn("codex.reset.auto_consumed", {
      request_id: requestId,
      credential_id: pending.credential_id,
      code: reply.result.code,
      config_revision: config.revision ?? null,
    });
    if (
      reply.result.code !== ConsumeResetCode.Reset &&
      reply.result.code !== ConsumeResetCode.AlreadyRedeemed
    ) {
      completed = true;
      return undefined;
    }
    const cleared = await clearCredentialQuotaCooldownUntil(
      env,
      provider.id,
      pending.credential_id,
      pending.cooling_until,
    );
    completed = true;
    holdMs = 0;
    return cleared ? pending.credential_id : undefined;
  } catch (error) {
    logWarn("codex.reset.auto_failed", {
      request_id: requestId,
      error: errorMessage(error),
    });
    return undefined;
  } finally {
    await releaseProviderLease(
      env,
      provider.id,
      RESET_LEASE,
      lease.owner,
      holdMs,
      completed,
    ).catch(() => {});
  }
}
