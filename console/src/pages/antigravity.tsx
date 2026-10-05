import { NativeProviderPage } from "@/features/oauth-accounts/native-provider-page";
import { AntigravityAccounts } from "@/features/antigravity/accounts";
import { AccountForm } from "@/features/antigravity/account-form";
import { AntigravitySettingsForm } from "@/features/antigravity/settings-form";

export default function Antigravity() {
  return (
    <NativeProviderPage
      type="antigravity"
      title="Antigravity"
      description="Google accounts and quotas."
      accountLabel="Google"
      accounts={AntigravityAccounts}
      settings={AntigravitySettingsForm}
      accountForm={AccountForm}
    />
  );
}
