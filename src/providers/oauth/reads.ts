import { ProviderType } from "../../config/values.ts";
import { antigravityAccountCredential } from "../antigravity/account-credential.ts";
import { codexAccountCredential } from "../codex/account-credential.ts";
import { claudeAccountCredential } from "../claude/account-credential.ts";
import { xaiAccountCredential } from "../xai/account-credential.ts";
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

/** Shared by the account runtime and coordinated, read-only snapshot access. */
export function activeAccount(account: AccountSnapshot) {
  if (account.status !== OAuthAccountStatus.Ready || !account.tokens)
    throw new OAuthError(
      "Reconnect this account before sending requests",
      503,
      "oauth_account_unavailable",
    );
  const generation = account.generation;
  let credential: AccountCredential;
  switch (account.provider_type) {
    case ProviderType.Antigravity:
      credential = antigravityAccountCredential(account);
      break;
    case ProviderType.Codex:
      credential = codexAccountCredential(account);
      break;
    case ProviderType.Claude:
      credential = claudeAccountCredential(account);
      break;
    case ProviderType.Xai:
      credential = xaiAccountCredential(account);
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
    !quotaIsStale(account, now)
  )
    return { ok: true, data: accountView(account) };
  if (command.action !== "resolve" && command.action !== "readiness") return;
  let active: ReturnType<typeof activeAccount>;
  try {
    active = activeAccount(account);
  } catch (error) {
    if (
      command.action === "readiness" &&
      error instanceof OAuthError &&
      error.code === "oauth_account_unavailable"
    )
      return { ok: true, data: { ready: false } };
    return;
  }
  if (command.action === "readiness")
    return { ok: true, data: { ready: true } };
  if (command.action !== "resolve") return;
  if (
    command.connection.provider_id !== account.provider_id ||
    active.tokens.expires_at <= now + TOKEN_REFRESH_MARGIN_MS
  )
    return;
  return { ok: true, data: active.credential };
}
