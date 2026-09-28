import type { ComponentProps } from "react";
import type { ClaudeProviderConfig } from "../../../../src/config/types";
import { OAuthAccountForm } from "../oauth-accounts/account-form";
import { Authorization } from "./authorization";
import { applyAccount } from "./form-options";

type Props = Omit<
  ComponentProps<typeof OAuthAccountForm>,
  "provider" | "onSave" | "authorization"
> & {
  provider: ClaudeProviderConfig;
  onSave: (provider: ClaudeProviderConfig) => Promise<void>;
};
export function AccountForm({ provider, onSave, ...props }: Props) {
  return (
    <OAuthAccountForm
      {...props}
      provider={provider}
      authorization={Authorization}
      onSave={(value) => onSave(applyAccount(provider, value))}
    />
  );
}
