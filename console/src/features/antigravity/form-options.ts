import { z } from "zod";
import {
  antigravityDraftProviderSchema,
  nameSchema,
  oauthCredentialSchema,
} from "../../../../src/config/schema";
import type {
  AntigravityProviderConfig,
  GatewayConfig,
} from "../../../../src/config/types";

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
    id: `account-${rowId}`,
    priority: 100,
    disabled: false,
    auth: { type: "oauth", account_ref: "" },
  };
}
export function newAntigravityProvider(): AntigravityProviderConfig {
  return {
    type: "antigravity",
    id: "antigravity",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: false,
    supports_context_management: false,
    supports_web_search: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
  };
}
export function antigravityProvider(
  config: GatewayConfig,
): AntigravityProviderConfig {
  return (
    config.providers.find((provider) => provider.type === "antigravity") ??
    newAntigravityProvider()
  );
}

export const settingsEditorSchema = antigravityDraftProviderSchema
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
    disabled: provider.disabled,
    proxy_group: provider.proxy_group,
    models: [...provider.models],
    retry: provider.retry,
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
  provider: AntigravityProviderConfig,
  value: SettingsFormValues,
): AntigravityProviderConfig {
  const { routes, ...settings } = settingsEditorSchema.parse(value);
  return antigravityDraftProviderSchema.parse({
    ...provider,
    ...settings,
    model_routes: Object.fromEntries(
      routes.map(({ alias, model }) => [alias, { model }]),
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
  return antigravityDraftProviderSchema.parse({ ...provider, credentials });
}

export function moveAccount(
  provider: AntigravityProviderConfig,
  id: string,
  direction: -1 | 1,
): AntigravityProviderConfig {
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
