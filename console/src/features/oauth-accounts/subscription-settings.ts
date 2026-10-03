import { z } from "zod";
import {
  claudeProviderFormSchema,
  nameSchema,
} from "../../../../src/config/schema";
import type {
  ClaudeProviderConfig,
  XaiProviderConfig,
} from "../../../../src/config/types";
export type SubscriptionProvider = ClaudeProviderConfig | XaiProviderConfig;
export const settingsEditorSchema = claudeProviderFormSchema
  .omit({
    id: true,
    type: true,
    credentials: true,
    model_routes: true,
    anthropic_1m_context: true,
    emulate_claude_code: true,
  })
  .extend({
    inject_x_search: z.boolean().optional(),
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
  provider: SubscriptionProvider,
): SettingsFormValues {
  return {
    ...(provider.type === "xai"
      ? { inject_x_search: provider.inject_x_search }
      : {}),
    priority: provider.priority,
    disabled: provider.disabled,
    proxy_group: provider.proxy_group,
    models: [...provider.models],
    retry: provider.retry,
    supports_websocket: provider.supports_websocket,
    supports_web_search: provider.supports_web_search,
    supports_context_management: provider.supports_context_management,
    account_selection: provider.account_selection,
    allow_extra_usage: provider.allow_extra_usage,
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
export function applySettings<Provider extends SubscriptionProvider>(
  provider: Provider,
  value: SettingsFormValues,
): Provider {
  const { routes, inject_x_search, ...settings } =
    settingsEditorSchema.parse(value);
  return {
    ...provider,
    ...settings,
    ...(provider.type === "xai"
      ? { inject_x_search: inject_x_search ?? false }
      : {}),
    model_routes: Object.fromEntries(
      routes.map(({ id, alias, model }) => [
        alias,
        { ...(id ? { id } : {}), model },
      ]),
    ),
  };
}
