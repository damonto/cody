import { z } from "zod";
import {
  codexProviderFormSchema,
  nameSchema,
} from "../../../../src/config/schema";
import type { CodexProviderConfig } from "../../../../src/config/types";

import {
  accountEditorSchema,
  type AccountFormValues,
} from "../oauth-accounts/form-options";

export {
  accountEditorSchema,
  newAccount,
  type AccountFormValues,
} from "../oauth-accounts/form-options";

export const settingsEditorSchema = codexProviderFormSchema
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
        id: route.id,
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
  return codexProviderFormSchema.parse({
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
  return codexProviderFormSchema.parse({ ...provider, credentials });
}

export {
  moveAccount,
  setAccountDisabled,
} from "../oauth-accounts/account-order";
