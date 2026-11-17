import { ProviderType } from "../../config/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type {
  AccountState,
  RefreshTokens,
  StoredFor,
} from "../oauth/provider.ts";
import { CODEX_ISSUER } from "./api.ts";
import { CodexRefreshNotSentError } from "./refresh-errors.ts";

/** The committed account tokens are the receipt; an unfinished claim never expires. */
export async function refreshCodexAccount<Result>(
  state: AccountState<typeof ProviderType.Codex>,
  generation: number,
  tokens: RefreshTokens,
  clientId: string,
  run: (beforeSend: () => Promise<void>) => Promise<Result>,
  commit: (
    account: StoredFor<typeof ProviderType.Codex>,
    result: Result,
  ) => void,
): Promise<void> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([CODEX_ISSUER, clientId, tokens.refresh_token]),
    ),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const snapshot = state.current();
  if (snapshot.generation !== generation)
    throw new OAuthError(
      "Account changed during refresh",
      409,
      "account_changed",
    );
  const previous = snapshot.codex_refresh;
  if (previous?.grant_hash === hash) {
    if (
      previous.status === "completed" &&
      snapshot.tokens &&
      snapshot.tokens.expires_at > Date.now()
    )
      return;
    throw new OAuthError(
      "The previous ChatGPT refresh cannot be repeated; sign in again to obtain a new grant",
      503,
      "refresh_outcome_unknown",
    );
  }
  if (previous?.status === "pending")
    throw new OAuthError(
      "The previous ChatGPT refresh outcome is unknown; sign in again",
      503,
      "refresh_outcome_unknown",
    );
  if (snapshot.tokens?.refresh_token !== tokens.refresh_token)
    throw new OAuthError(
      "Token rotation superseded this refresh",
      409,
      "account_changed",
    );
  let claimed = false;
  const beforeSend = async () => {
    if (claimed)
      throw new OAuthError(
        "A refresh grant cannot be sent twice",
        503,
        "refresh_outcome_unknown",
      );
    if ((tokens.earliest_refresh_at ?? 0) > Date.now())
      throw new OAuthError(
        "ChatGPT token renewal is not available yet",
        503,
        "refresh_not_ready",
      );
    await state.update(generation, (account) => {
      if (
        account.tokens?.refresh_token !== tokens.refresh_token ||
        (account.codex_refresh?.grant_hash === hash &&
          account.codex_refresh.status === "completed")
      )
        throw new OAuthError(
          "Token rotation superseded this refresh",
          409,
          "account_changed",
        );
      if (account.codex_refresh?.status === "pending")
        throw new OAuthError(
          "ChatGPT token refresh is already pending",
          503,
          "refresh_outcome_unknown",
        );
      account.codex_refresh = {
        status: "pending",
        grant_hash: hash,
        started_at: Date.now(),
      };
    });
    claimed = true;
  };
  let result: Result;
  try {
    result = await run(beforeSend);
  } catch (error) {
    if (claimed && error instanceof CodexRefreshNotSentError)
      await state.update(generation, (account) => {
        if (
          account.codex_refresh?.status === "pending" &&
          account.codex_refresh.grant_hash === hash
        )
          account.codex_refresh = previous;
      });
    throw error;
  }
  if (!claimed)
    throw new OAuthError(
      "Token refresh was not fenced",
      503,
      "refresh_outcome_unknown",
    );
  await state.update(generation, (account) => {
    const pending = account.codex_refresh;
    if (pending?.status !== "pending" || pending.grant_hash !== hash)
      throw new OAuthError(
        "Account changed during refresh",
        409,
        "account_changed",
      );
    commit(account, result);
    account.codex_refresh = {
      ...pending,
      status: "completed",
      rotated: account.tokens?.refresh_token !== tokens.refresh_token,
    };
  });
}
