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

/** Toggles one account without opening its editor. */
export function setAccountDisabled(
  provider: XaiProviderConfig,
  id: string,
  disabled: boolean,
): XaiProviderConfig {
  return {
    ...provider,
    credentials: provider.credentials.map((credential) =>
      credential.id === id ? { ...credential, disabled } : credential,
    ),
  };
}

export function moveAccount(
  provider: XaiProviderConfig,
  id: string,
  direction: -1 | 1,
): XaiProviderConfig {
  const index = provider.credentials.findIndex(
    (credential) => credential.id === id,
  );
  const target = index + direction;
  if (index < 0 || target < 0 || target >= provider.credentials.length)
    return provider;
  const credentials = [...provider.credentials];
  [credentials[index], credentials[target]] = [
    credentials[target],
    credentials[index],
  ];
  return { ...provider, credentials };
}
