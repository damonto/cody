import type { ComponentProps } from "react";
import type { CodexProviderConfig } from "../../../../src/config/types";
import { OAuthAccountForm } from "../oauth-accounts/account-form";
import { Authorization } from "./authorization";
import { applyAccount } from "./form-options";

type Props = Omit<
  ComponentProps<typeof OAuthAccountForm>,
  "provider" | "onSave" | "renderAuthorization"
> & {
  provider: CodexProviderConfig;
  onSave: (provider: CodexProviderConfig) => Promise<void>;
};
export function AccountForm({ provider, onSave, ...props }: Props) {
  return (
    <OAuthAccountForm
      {...props}
      provider={provider}
      renderAuthorization={(options) => <Authorization {...options} />}
      onSave={(value) => onSave(applyAccount(provider, value))}
    />
  );
}
