import { xaiProviderFormSchema } from "../../../../src/config/schema";
import type { XaiProviderConfig } from "../../../../src/config/types";

import {
  accountEditorSchema,
  type AccountFormValues,
} from "../oauth-accounts/form-options";

export {
  accountEditorSchema,
  newAccount,
  type AccountFormValues,
} from "../oauth-accounts/form-options";

export {
  settingsEditorSchema,
  settingsFormValues,
  applySettings,
  type SettingsFormValues,
} from "../oauth-accounts/subscription-settings";

export function applyAccount(
  provider: XaiProviderConfig,
  value: AccountFormValues,
): XaiProviderConfig {
  const { rowId: _rowId, ...credential } = accountEditorSchema.parse(value);
  const index = provider.credentials.findIndex(
    (entry) => entry.id === credential.id,
  );
  const credentials = [...provider.credentials];
  if (index === -1) credentials.push(credential);
  else credentials[index] = credential;
  return xaiProviderFormSchema.parse({ ...provider, credentials });
}

export {
  moveAccount,
  setAccountDisabled,
} from "../oauth-accounts/account-order";
