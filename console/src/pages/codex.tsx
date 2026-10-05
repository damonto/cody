import { NativeProviderPage } from "@/features/oauth-accounts/native-provider-page";
import { CodexAccounts } from "@/features/codex/accounts";
import { AccountForm } from "@/features/codex/account-form";
import { CodexSettingsForm } from "@/features/codex/settings-form";

export default function Codex() {
  return (
    <NativeProviderPage
      type="codex"
      title="Codex"
      description="ChatGPT accounts, quotas and resets."
      accountLabel="ChatGPT"
      accounts={CodexAccounts}
      settings={CodexSettingsForm}
      accountForm={AccountForm}
    />
  );
}
