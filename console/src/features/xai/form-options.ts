import {
  CodexAccountSelection,
  ProviderType,
} from "../../../../src/config/values.ts";

import { xaiDraftProviderSchema } from "../../../../src/config/schema";
import type {
  XaiProviderConfig,
  GatewayConfig,
} from "../../../../src/config/types";

import {
  accountEditorSchema,
  type AccountFormValues,
} from "../oauth-accounts/form-options";

export {
  accountEditorSchema,
  newAccount,
  type AccountFormValues,
} from "../oauth-accounts/form-options";
export function newXaiProvider(): XaiProviderConfig {
  return {
    type: ProviderType.Xai,
    id: "xai",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: false,
    supports_context_management: false,
    supports_web_search: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    account_selection: CodexAccountSelection.RoundRobin,
    allow_extra_usage: false,
    inject_x_search: false,
  };
}
export function xaiProvider(config: GatewayConfig): XaiProviderConfig {
  return (
    config.providers.find((provider) => provider.type === ProviderType.Xai) ??
    newXaiProvider()
  );
}

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
  return xaiDraftProviderSchema.parse({ ...provider, credentials });
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
