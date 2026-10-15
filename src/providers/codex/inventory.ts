import { ProviderType } from "../../config/values.ts";
import { logWarn } from "../../shared/log.ts";
import {
  OAuthError,
  type QuotaSnapshot,
  type ConsumeResetResult,
} from "../oauth/schema.ts";
import { safeError } from "../oauth/state.ts";
import type { AccountState } from "../oauth/provider.ts";
import { type CodexClient, parseModels, parseResetCredits } from "./api.ts";
import { mergeCodexQuotaRefresh, parseUsage } from "./quota.ts";
import { codexCredentialSchema } from "./account-schema.ts";
import type { z } from "zod";
type CodexAccess = z.output<typeof codexCredentialSchema>;
interface CodexReadResult<T> {
  readonly value: T;
  readonly credential: CodexAccess;
}

/** Codex inventory recovery and quota merging share the account's fenced state. */
export class CodexInventory {
  constructor(
    private readonly state: AccountState<typeof ProviderType.Codex>,
    private readonly client: () => Promise<
      Pick<CodexClient, "models" | "usage" | "resetCredits" | "consumeReset">
    >,
  ) {}
  /** Retry read-only metadata once with a fenced credential refresh. */
  private async codexRead<T>(
    token: CodexAccess,
    read: (accessToken: string) => Promise<T>,
  ): Promise<CodexReadResult<T>> {
    try {
      return { value: await read(token.token), credential: token };
    } catch (error) {
      if (!(error instanceof OAuthError) || error.status !== 401) throw error;
      const refreshed = await this.state.resolve({
        generation: token.generation,
        token: token.token,
      });
      if (
        !("account_id" in refreshed) ||
        refreshed.account_id !== token.account_id ||
        refreshed.generation !== token.generation
      )
        throw new OAuthError(
          "Account changed during authentication recovery",
          409,
          "account_changed",
        );
      return { value: await read(refreshed.token), credential: refreshed };
    }
  }
  async models() {
    const token = codexCredentialSchema.parse(await this.state.resolve());
    return parseModels(
      (
        await this.codexRead(token, async (access) =>
          (await this.client()).models(access, token.account_id),
        )
      ).value,
    );
  }
  async quota(generation: number): Promise<void> {
    let token = codexCredentialSchema.parse(await this.state.resolve());
    const startedAt = Date.now();
    let completedAt = startedAt;
    let usage: ReturnType<typeof parseUsage> | undefined;
    let lastError: string | null = null;
    try {
      const result = await this.codexRead(token, async (access) =>
        (await this.client()).usage(access, token.account_id),
      );
      token = result.credential;
      completedAt = Date.now();
      usage = parseUsage(result.value, completedAt);
    } catch (error) {
      lastError = safeError(error);
    }
    // A reset-credit lookup failure never hides the usage windows.
    const resets = await this.fetchResetCredits(token);
    await this.state.update(generation, (account) => {
      if (account.provider_type !== ProviderType.Codex)
        throw new OAuthError("Account provider changed", 409);
      if (usage)
        Object.assign(
          account,
          mergeCodexQuotaRefresh(account, usage, startedAt, completedAt),
        );
      account.quota.reset_credits = resets;
      account.quota.last_error = lastError;
    });
  }
  private async fetchResetCredits(
    token: CodexAccess,
  ): Promise<NonNullable<QuotaSnapshot["reset_credits"]>> {
    const previous = this.state.current().quota.reset_credits;
    try {
      return {
        ...parseResetCredits(
          (
            await this.codexRead(token, async (access) =>
              (await this.client()).resetCredits(access, token.account_id),
            )
          ).value,
        ),
        updated_at: Date.now(),
        error: null,
      };
    } catch (error) {
      return {
        available_count: previous?.available_count ?? 0,
        credits: [...(previous?.credits ?? [])],
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
    const resets = await this.fetchResetCredits(token);
    await this.state.update(generation, (account) => {
      account.quota.reset_credits = resets;
    });
  }
  async consumeReset(
    redeemRequestId: string,
    creditId?: string,
  ): Promise<ConsumeResetResult> {
    const token = codexCredentialSchema.parse(await this.state.resolve());
    const result = await (
      await this.client()
    ).consumeReset(token.token, token.account_id, redeemRequestId, creditId);
    logWarn("oauth.codex.reset_consumed", {
      code: result.code,
      windows_reset: result.windows_reset,
    });
    return result;
  }
}
