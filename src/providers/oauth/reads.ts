import { accountPartition } from "../codex/partition.ts";
import type { CodexMode } from "../codex/account-schema.ts";
import { ProviderType } from "../../config/values.ts";
import { codexAccountCredential } from "../codex/account-credential.ts";
import { claudeAccountCredential } from "../claude/account-credential.ts";
import type { AccountCommand } from "./commands.ts";
import { accountView } from "./presentation.ts";
import { TOKEN_REFRESH_MARGIN_MS, type AccountCredential } from "./provider.ts";
import { OAuthError, type AccountReply } from "./schema.ts";
import {
  nextAccountAlarm,
  quotaIsStale,
  terminalSessionStatuses,
  type AccountSnapshot,
} from "./state.ts";
import { OAuthAccountStatus } from "./values.ts";
import { codexRefreshBlocked } from "../codex/refresh-state.ts";

/** A blocked renewal must not discard an access token that is still valid. */
export function accountRefreshAt(account: AccountSnapshot): number {
  const tokens = account.tokens;
  if (!tokens) return 0;
  if (
    account.provider_type === ProviderType.Codex &&
    codexRefreshBlocked(account.codex_refresh)
  )
    return Infinity;
  let retryAt = 0;
  if (account.provider_type === ProviderType.Claude)
    retryAt = account.claude_refresh.next_at;
  return Math.max(
    tokens.expires_at - TOKEN_REFRESH_MARGIN_MS,
    tokens.earliest_refresh_at ?? 0,
    retryAt,
  );
}

/** Shared by the account runtime and coordinated, read-only snapshot access. */
export function activeAccount(
  snapshot: AccountSnapshot,
  mode: CodexMode = "native",
) {
  const account = accountPartition(snapshot, mode);
  if (account.status !== OAuthAccountStatus.Ready || !account.tokens)
    throw new OAuthError(
      "Reconnect this account before sending requests",
      503,
      "oauth_account_unavailable",
    );
  const generation = account.generation;
  let credential: AccountCredential;
  switch (account.provider_type) {
    case ProviderType.Codex:
      credential = codexAccountCredential(account);
      break;
    case ProviderType.Claude:
      credential = claudeAccountCredential(account);
      break;
  }
  return { generation, tokens: account.tokens, credential };
}

/** Undefined means this command needs the serialized account lifecycle. */
export function readAccountSnapshot(
  account: AccountSnapshot,
  command: AccountCommand,
  now = Date.now(),
): AccountReply | undefined {
  const session = account.session;
  if (
    session &&
    !terminalSessionStatuses.has(session.status) &&
    session.expires_at <= now
  )
    return;
  const alarm = nextAccountAlarm(account);
  if (command.action !== "readiness" && alarm !== null && alarm <= now) return;
  if (command.action === "view")
    return { ok: true, data: accountView(account) };
  if (
    command.action === "quota" &&
    !command.force &&
    !quotaIsStale(accountPartition(account, command.mode), now)
  )
    return { ok: true, data: accountView(account) };
  if (command.action !== "resolve" && command.action !== "readiness") return;
  if (command.action === "readiness")
    return { ok: true, data: accountReadiness(account, command.mode, now) };
  let active: ReturnType<typeof activeAccount>;
  try {
    active = activeAccount(account, command.mode);
  } catch {
    return;
  }
  if (command.action !== "resolve") return;
  if (
    command.connection.provider_id !== account.provider_id ||
    active.tokens.expires_at <= now ||
    accountRefreshAt(accountPartition(account, command.mode)) <= now
  )
    return;
  return { ok: true, data: active.credential };
}

/** Token-free projection shared by locked and coordinated snapshot reads. */
export function accountReadiness(
  account: AccountSnapshot,
  selectedMode: CodexMode = "native",
  now = Date.now(),
) {
  const mode =
    account.provider_type === ProviderType.Codex ? selectedMode : undefined;
  let ready = false;
  try {
    const active = activeAccount(account, selectedMode);
    const partition = accountPartition(account, selectedMode);
    if (active.tokens.expires_at <= now && accountRefreshAt(partition) > now)
      throw new OAuthError(
        "Token renewal is unavailable",
        503,
        "oauth_account_unavailable",
      );
    ready = true;
  } catch (error) {
    if (
      !(error instanceof OAuthError) ||
      error.code !== "oauth_account_unavailable"
    )
      throw error;
  }
  return {
    ready,
    ...(mode
      ? {
          codex_mode: mode,
          generation: accountPartition(account, mode).generation,
        }
      : {}),
  };
}
