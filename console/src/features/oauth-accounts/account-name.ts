import type {
  AccountView,
  OAuthProviderType,
} from "../../../../src/providers/oauth/schema";

/** Only new credentials adopt a name from their authorized account. */
export function accountName(
  provider: OAuthProviderType,
  account: AccountView,
): string {
  const email = account.email?.trim();
  if (email) return email;
  const identifier = {
    antigravity: undefined,
    codex: account.codex?.account_id,
    claude: account.claude?.account_id,
    xai: account.xai?.subject,
  }[provider];
  return identifier?.trim() || `${provider}:${account.account_ref}`;
}
