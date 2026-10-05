import { type XaiClient } from "../xai/api.ts";
import { xaiModels } from "../xai/models.ts";
import {
  type ClaudeClient,
  parseModels as parseClaudeModels,
  parseUsage as parseClaudeUsage,
} from "../claude/api.ts";

import { ProviderType } from "../../config/values.ts";

import type { z } from "zod";

import { logWarn } from "../../shared/log.ts";

import {
  AntigravityVerificationError,
  mergeVerification,
} from "../antigravity/verification.ts";

import {
  type AntigravityClient,
  parseModels as parseAntigravityModels,
  parseQuota,
  parseSubscription,
} from "../antigravity/api.ts";
import {
  type CodexClient,
  parseModels as parseCodexModels,
  parseResetCredits,
  parseUsage,
} from "../codex/api.ts";

import {
  OAuthError,
  type AccountView,
  type ConsumeResetResult,
  type QuotaSnapshot,
} from "./schema.ts";

import { accountView } from "./presentation.ts";
import { safeError, type Stored } from "./state.ts";
import type { resolvedOAuthSchema } from "./schema.ts";

interface InventoryState {
  current(): Stored;
  update(
    generation: number,
    update: (account: Stored) => void | Promise<void>,
  ): Promise<void>;
  refresh(
    kind: "models" | "quota",
    generation: number,
    run: () => Promise<void>,
  ): Promise<void>;
  resolve(): Promise<z.output<typeof resolvedOAuthSchema>>;
}
interface InventoryClients {
  antigravity(): Promise<Pick<AntigravityClient, "models" | "quota" | "load">>;
  codex(): Promise<
    Pick<CodexClient, "models" | "usage" | "resetCredits" | "consumeReset">
  >;
  claude(): Promise<Pick<ClaudeClient, "models" | "usage">>;
  xai(): Promise<Pick<XaiClient, "quota">>;
}
/** Owns provider metadata refresh; the account core owns token resolution and fenced commits. */
export class AccountInventory {
  constructor(
    private readonly state: InventoryState,
    private readonly clients: InventoryClients,
  ) {}
  refreshModels(): Promise<void> {
    const generation = this.state.current().generation;
    return this.state.refresh("models", generation, async () => {
      try {
        if (this.state.current().provider_type === ProviderType.Xai) {
          await this.state.update(generation, (account) => {
            account.models = xaiModels();
            account.models_updated_at = Date.now();
            account.models_error = null;
          });
          return;
        }
        const token = await this.state.resolve();
        if ("xai_subject" in token)
          throw new OAuthError("Unexpected account type", 500);
        const models =
          "claude_organization_id" in token
            ? parseClaudeModels(
                await (await this.clients.claude()).models(token.token),
              )
            : "account_id" in token
              ? parseCodexModels(
                  await (
                    await this.clients.codex()
                  ).models(token.token, token.account_id),
                )
              : parseAntigravityModels(
                  await (
                    await this.clients.antigravity()
                  ).models(token.token, token.project_id),
                );
        await this.state.update(generation, (account) => {
          account.models = models;
          account.models_updated_at = Date.now();
          account.models_error = null;
          delete account.models_verification;
        });
      } catch (error) {
        if (this.state.current().generation === generation)
          await this.state.update(generation, (account) => {
            account.models_error = safeError(error);
            account.models_verification =
              error instanceof AntigravityVerificationError
                ? error.verification
                : undefined;
          });
      }
    });
  }
  async refreshQuota(force: boolean): Promise<void> {
    if (!force && !accountView(this.state.current()).quota.stale) return;
    const generation = this.state.current().generation;
    await this.state.refresh("quota", generation, async () => {
      try {
        const token = await this.state.resolve();
        if ("xai_subject" in token) {
          const usage = await (
            await this.clients.xai()
          ).quota(token.token, token.xai_subject);
          await this.state.update(generation, (account) => {
            account.quota = { ...usage, xai_limits: account.quota.xai_limits };
          });
          return;
        }
        if ("claude_organization_id" in token) {
          const revision = this.state.current().claude_quota_revision;
          const usage = parseClaudeUsage(
            await (await this.clients.claude()).usage(token.token),
          );
          await this.state.update(generation, (account) => {
            if (account.claude_quota_revision !== revision) return;
            account.quota = {
              ...account.quota,
              ...usage,
              updated_at: Date.now(),
              last_error: null,
              stale: false,
              subscription: {
                tier_id: account.claude?.subscription_type ?? null,
                tier_name: account.claude?.rate_limit_tier ?? null,
                credits: [],
              },
            };
          });
          return;
        }
        if ("account_id" in token)
          return await this.refreshCodexQuota(
            generation,
            token.token,
            token.account_id,
          );
        let groups: QuotaSnapshot["groups"] | undefined;
        let subscription: QuotaSnapshot["subscription"] | undefined;
        const errors = new Set<string>();
        const verification: NonNullable<QuotaSnapshot["verification"]> = [];
        // Independent transports, serialized so a six-account batch has at most six requests in flight.
        // Preparation and parsing belong to each operation's failure boundary too.
        try {
          groups = parseQuota(
            await (
              await this.clients.antigravity()
            ).quota(token.token, token.project_id),
          );
        } catch (error) {
          errors.add(safeError(error));
          if (error instanceof AntigravityVerificationError)
            verification.push(...error.verification);
        }
        try {
          subscription = parseSubscription(
            await (await this.clients.antigravity()).load(token.token),
          );
        } catch (error) {
          errors.add(safeError(error));
          if (error instanceof AntigravityVerificationError)
            verification.push(...error.verification);
        }
        await this.state.update(generation, (account) => {
          if (groups !== undefined) {
            account.quota.groups = groups;
            account.quota.updated_at = Date.now();
          }
          if (subscription !== undefined)
            account.quota.subscription = subscription;
          account.quota.last_error = [...errors].join(" ") || null;
          account.quota.verification = verification.length
            ? mergeVerification(verification)
            : undefined;
        });
      } catch (error) {
        if (this.state.current().generation === generation)
          await this.state.update(generation, (account) => {
            account.quota.last_error = safeError(error);
            delete account.quota.verification;
          });
      }
    });
  }
  private async refreshCodexQuota(
    generation: number,
    token: string,
    accountId: string,
  ): Promise<void> {
    let usage: ReturnType<typeof parseUsage> | undefined;
    let lastError: string | null = null;
    try {
      usage = parseUsage(
        await (await this.clients.codex()).usage(token, accountId),
      );
    } catch (error) {
      lastError = safeError(error);
    }
    // A reset-credit lookup failure never hides the usage windows.
    const resets = await this.fetchResetCredits(token, accountId);
    await this.state.update(generation, (account) => {
      const now = Date.now();
      if (usage) {
        account.quota.groups = usage.groups;
        account.quota.updated_at = now;
        account.quota.limit_reached = usage.limit_reached;
        account.quota.credits_balance = usage.credits_balance;
        if (account.codex && usage.plan_type)
          account.codex = { ...account.codex, plan_type: usage.plan_type };
        account.quota.subscription = {
          tier_id: usage.plan_type ?? account.codex?.plan_type ?? null,
          tier_name: null,
          credits: [],
          active_until: account.codex?.subscription_active_until ?? null,
        };
      }
      account.quota.reset_credits = resets;
      account.quota.last_error = lastError;
    });
  }
  private async fetchResetCredits(
    token: string,
    accountId: string,
  ): Promise<NonNullable<QuotaSnapshot["reset_credits"]>> {
    const previous = this.state.current().quota.reset_credits;
    try {
      return {
        ...parseResetCredits(
          await (await this.clients.codex()).resetCredits(token, accountId),
        ),
        updated_at: Date.now(),
        error: null,
      };
    } catch (error) {
      return {
        available_count: previous?.available_count ?? 0,
        credits: previous?.credits ?? [],
        updated_at: previous?.updated_at ?? null,
        error: safeError(error),
      };
    }
  }
  async refreshResetCredits(): Promise<void> {
    const generation = this.state.current().generation;
    const token = await this.state.resolve();
    if (!("account_id" in token))
      throw new OAuthError("This operation is only available for Codex", 400);
    const resets = await this.fetchResetCredits(token.token, token.account_id);
    await this.state.update(generation, (account) => {
      account.quota.reset_credits = resets;
    });
  }
  /** Spends one reset credit; the redeem ID makes a retried request idempotent upstream. */
  async consumeReset(
    redeemRequestId: string,
    creditId?: string,
  ): Promise<{ result: ConsumeResetResult; account: AccountView }> {
    const token = await this.state.resolve();
    if (!("account_id" in token))
      throw new OAuthError("This operation is only available for Codex", 400);
    const result = await (
      await this.clients.codex()
    ).consumeReset(token.token, token.account_id, redeemRequestId, creditId);
    logWarn("oauth.codex.reset_consumed", {
      code: result.code,
      windows_reset: result.windows_reset,
    });
    await this.refreshQuota(true);
    return { result, account: accountView(this.state.current()) };
  }
}
