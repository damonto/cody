import {
  CodexAccountSelection,
  CredentialAuthType,
  ProviderType,
} from "../../../../src/config/values.ts";

import { z } from "zod";
import {
  codexDraftProviderSchema,
  nameSchema,
  oauthCredentialSchema,
} from "../../../../src/config/schema";
import type {
  CodexProviderConfig,
  GatewayConfig,
} from "../../../../src/config/types";

export const accountEditorSchema = oauthCredentialSchema.extend({
  rowId: z.string().min(1),
  auth: oauthCredentialSchema.shape.auth.extend({
    account_ref: z.uuid({
      error: "Authorize or select a ChatGPT account before saving.",
    }),
  }),
});
export type AccountFormValues = z.input<typeof accountEditorSchema>;

export function newAccount(): AccountFormValues {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    id: `account-${rowId}`,
    priority: 100,
    disabled: false,
    auth: { type: CredentialAuthType.OAuth, account_ref: "" },
  };
}
export function newCodexProvider(): CodexProviderConfig {
  return {
    type: ProviderType.Codex,
    id: "codex",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: true,
    supports_context_management: false,
    supports_web_search: true,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    account_selection: CodexAccountSelection.RoundRobin,
    auto_consume_resets: false,
  };
}
export function codexProvider(config: GatewayConfig): CodexProviderConfig {
  return (
    config.providers.find((provider) => provider.type === ProviderType.Codex) ??
    newCodexProvider()
  );
}

export const settingsEditorSchema = codexDraftProviderSchema
  .omit({
    id: true,
    type: true,
    credentials: true,
    model_routes: true,
    anthropic_1m_context: true,
    emulate_claude_code: true,
  })
  .extend({
    routes: z
      .array(
        z.strictObject({
          rowId: z.string().min(1),
          alias: nameSchema,
          model: nameSchema,
        }),
      )
      .superRefine((routes, context) => {
        const aliases = new Set<string>();
        routes.forEach((route, index) => {
          if (aliases.has(route.alias))
            context.addIssue({
              code: "custom",
              path: [index, "alias"],
              message: "Model aliases must be unique",
            });
          aliases.add(route.alias);
        });
      }),
  });
export type SettingsFormValues = z.input<typeof settingsEditorSchema>;

export function settingsFormValues(
  provider: CodexProviderConfig,
): SettingsFormValues {
  return {
    priority: provider.priority,
    disabled: provider.disabled,
    proxy_group: provider.proxy_group,
    models: [...provider.models],
    retry: provider.retry,
    supports_websocket: provider.supports_websocket,
    supports_web_search: provider.supports_web_search,
    supports_context_management: provider.supports_context_management,
    account_selection: provider.account_selection,
    auto_consume_resets: provider.auto_consume_resets,
    routes: Object.entries(provider.model_routes ?? {}).map(
      ([alias, route]) => ({
        rowId: crypto.randomUUID(),
        alias,
        model: route.model,
      }),
    ),
  };
}
export function applySettings(
  provider: CodexProviderConfig,
  value: SettingsFormValues,
): CodexProviderConfig {
  const { routes, ...settings } = settingsEditorSchema.parse(value);
  return codexDraftProviderSchema.parse({
    ...provider,
    ...settings,
    model_routes: Object.fromEntries(
      routes.map(({ alias, model }) => [alias, { model }]),
    ),
  });
}

export function applyAccount(
  provider: CodexProviderConfig,
  value: AccountFormValues,
): CodexProviderConfig {
  const { rowId: _rowId, ...credential } = accountEditorSchema.parse(value);
  const index = provider.credentials.findIndex(
    (entry) => entry.id === credential.id,
  );
  const credentials = [...provider.credentials];
  if (index === -1) credentials.push(credential);
  else credentials[index] = credential;
  return codexDraftProviderSchema.parse({ ...provider, credentials });
}

/** Toggles one account without opening its editor. */
export function setAccountDisabled(
  provider: CodexProviderConfig,
  id: string,
  disabled: boolean,
): CodexProviderConfig {
  return {
    ...provider,
    credentials: provider.credentials.map((credential) =>
      credential.id === id ? { ...credential, disabled } : credential,
    ),
  };
}

export function moveAccount(
  provider: CodexProviderConfig,
  id: string,
  direction: -1 | 1,
): CodexProviderConfig {
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
