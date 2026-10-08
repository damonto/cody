import { NativeProviderPage } from "@/features/oauth-accounts/native-provider-page";
import { XaiAccounts } from "@/features/xai/accounts";
import { AccountForm } from "@/features/xai/account-form";
import { XaiSettingsForm } from "@/features/xai/settings-form";

export default function Xai() {
  return (
    <NativeProviderPage
      type="xai"
      title="SpaceXAI"
      description="SpaceXAI accounts and subscription quotas."
      accountLabel="SpaceXAI"
      accounts={XaiAccounts}
      settings={XaiSettingsForm}
      accountForm={AccountForm}
    />
  );
}
