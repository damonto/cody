import { CredentialAuthType } from "../../../../src/config/values.ts";

import { z } from "zod";
import {
  antigravityProviderFormSchema,
  nameSchema,
  oauthCredentialSchema,
} from "../../../../src/config/schema";
import type { AntigravityProviderConfig } from "../../../../src/config/types";

export const accountEditorSchema = oauthCredentialSchema.extend({
  rowId: z.string().min(1),
  auth: oauthCredentialSchema.shape.auth.extend({
    account_ref: z.uuid({
      error: "Authorize or select a Google account before saving.",
    }),
  }),
});
export type AccountFormValues = z.input<typeof accountEditorSchema>;

export function newAccount(): AccountFormValues {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    id: rowId,
    name: "Account",
    priority: 100,
    disabled: false,
    auth: { type: CredentialAuthType.OAuth, account_ref: "" },
  };
}

export const settingsEditorSchema = antigravityProviderFormSchema
  .omit({
    id: true,
    type: true,
    credentials: true,
    model_routes: true,
    supports_websocket: true,
    supports_context_management: true,
    supports_web_search: true,
    anthropic_1m_context: true,
    emulate_claude_code: true,
  })
  .extend({
    routes: z
      .array(
        z.strictObject({
          rowId: z.string().min(1),
          id: z.string().optional(),
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
  provider: AntigravityProviderConfig,
): SettingsFormValues {
  return {
    priority: provider.priority,
    account_selection: provider.account_selection,
    sensitive_words: [...(provider.sensitive_words ?? [])],
    disabled: provider.disabled,
    proxy_group: provider.proxy_group,
    models: [...provider.models],
    retry: provider.retry,
    routes: Object.entries(provider.model_routes ?? {}).map(
      ([alias, route]) => ({
        rowId: crypto.randomUUID(),
        id: route.id,
        alias,
        model: route.model,
      }),
    ),
  };
}
export function applySettings(
  provider: AntigravityProviderConfig,
  value: SettingsFormValues,
): AntigravityProviderConfig {
  const { routes, ...settings } = settingsEditorSchema.parse(value);
  return antigravityProviderFormSchema.parse({
    ...provider,
    ...settings,
    model_routes: Object.fromEntries(
      routes.map(({ id, alias, model }) => [
        alias,
        { ...(id ? { id } : {}), model },
      ]),
    ),
  });
}

export function applyAccount(
  provider: AntigravityProviderConfig,
  value: AccountFormValues,
): AntigravityProviderConfig {
  const { rowId: _rowId, ...credential } = accountEditorSchema.parse(value);
  const index = provider.credentials.findIndex(
    (entry) => entry.id === credential.id,
  );
  const credentials = [...provider.credentials];
  if (index === -1) credentials.push(credential);
  else credentials[index] = credential;
  return antigravityProviderFormSchema.parse({ ...provider, credentials });
}

export { moveAccount } from "../oauth-accounts/account-order";
