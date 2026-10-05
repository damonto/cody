import { NativeProviderPage } from "@/features/oauth-accounts/native-provider-page";
import { ClaudeAccounts } from "@/features/claude/accounts";
import { AccountForm } from "@/features/claude/account-form";
import { ClaudeSettingsForm } from "@/features/claude/settings-form";

export default function Claude() {
  return (
    <NativeProviderPage
      type="claude"
      title="Claude"
      description="Claude accounts and subscription quotas."
      accountLabel="Claude"
      accounts={ClaudeAccounts}
      settings={ClaudeSettingsForm}
      accountForm={AccountForm}
    />
  );
}
