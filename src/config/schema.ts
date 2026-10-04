import {
  providerModelNames,
  supportsProviderModel,
} from "../shared/antigravity-models.ts";
import { tokenCountSchema } from "../billing/schema.ts";

import {
  ProxyStrategy,
  CodexAccountSelection,
  CredentialAuthType,
  ProviderType,
} from "./values.ts";

import { z } from "zod";
import {
  modelPricesSchema,
  reportingSchema,
  validateModelPriceReferences,
} from "../billing/schema.ts";
import { SEARCH_PROVIDERS } from "../shared/search.ts";
import { secretSchema } from "../shared/secret-schema.ts";

export const identifierSchema = z
  .string({ error: "must be a non-empty string" })
  .min(1, "must be a non-empty string")
  .max(256)
  .regex(/^[A-Za-z0-9._-]+$/, "contains unsupported characters");
export const nameSchema = z
  .string({ error: "must be a non-empty string" })
  .trim()
  .min(1, "must be a non-empty string")
  .max(256);
const integer = z
  .number({ error: "must be an integer" })
  .int({ error: "must be an integer" });
const boolean = z.boolean({ error: "must be a boolean" });
const baseUrlSchema = z
  .url("must be an absolute http(s) URL")
  .trim()
  .regex(/^https?:\/\//, "must use http or https")
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null && !url.username && !url.password && !url.search && !url.hash
    );
  }, "must not contain credentials, query parameters, or a fragment")
  .transform((value) => value.replace(/\/+$/, ""));

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}
const nameList = z
  .array(nameSchema, { error: "must be a non-empty array" })
  .refine(unique, "must not contain duplicates");
const names = nameList.min(1, "must be a non-empty array");
export const routeSchema = z.strictObject({
  id: z.uuid().optional(),
  model: nameSchema,
  providers: names.optional(),
});
const providerRouteSchema = z.strictObject({
  id: z.uuid().optional(),
  model: nameSchema,
});

function routes<T extends z.ZodType>(route: T) {
  return z
    .record(z.string().regex(/\S/, "must be a non-empty string"), route)
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      for (const key of Object.keys(entries)) {
        const normalized = key.trim();
        if (seen.has(normalized))
          context.addIssue({
            code: "custom",
            message: `contains duplicate normalized model ${normalized}`,
          });
        seen.add(normalized);
      }
    })
    .transform((entries) =>
      Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [key.trim(), value]),
      ),
    );
}

export const retrySchema = z
  .strictObject({
    status_codes: z
      .array(
        integer
          .min(400, "must be between 400 and 599")
          .max(599, "must be between 400 and 599"),
      )
      .max(20, "must contain at most 20 items")
      .refine(unique, "must not contain duplicates"),
    error_codes: z
      .array(nameSchema)
      .max(20, "must contain at most 20 items")
      .refine(unique, "must not contain duplicates")
      .optional(),
    delays_ms: z
      .array(
        integer
          .min(0, "must be between 0 and 60000")
          .max(60_000, "must be between 0 and 60000"),
      )
      .max(10, "must contain at most 10 items"),
  })
  .refine(
    (value) =>
      (value.status_codes.length === 0 && !value.error_codes?.length) ===
      (value.delays_ms.length === 0),
    "status_codes or error_codes must be non-empty exactly when delays_ms is non-empty",
  );

const socksCredentialSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 255,
    "must contain at most 255 UTF-8 bytes",
  );
export const socksProxySchema = z
  .strictObject({
    url: z
      .url("must be an absolute socks5 URL")
      .trim()
      .max(2048)
      .regex(/^socks5:\/\//, "must use socks5")
      .refine((value) => {
        const url = URL.parse(value);
        return (
          url !== null &&
          !!url.hostname &&
          !!url.port &&
          Number(url.port) > 0 &&
          !url.username &&
          !url.password &&
          (!url.pathname || url.pathname === "/") &&
          !url.search &&
          !url.hash &&
          URL.canParse(value.replace(/^socks5:/, "http:"))
        );
      }, "must include a host and port (1–65535), without credentials, a path, query, or fragment")
      .transform((value) => value.replace(/\/$/, "")),
    username: socksCredentialSchema.optional(),
    password: socksCredentialSchema.optional(),
  })
  .refine(
    (value) =>
      (value.username === undefined) === (value.password === undefined),
    "username and password must be supplied together",
  );
export const proxyNodeSchema = socksProxySchema.safeExtend({
  id: identifierSchema,
  name: z.string().trim().min(1).max(256).optional(),
  priority: integer,
  disabled: boolean,
});
export const proxyStrategySchema = z.enum(ProxyStrategy);
export const proxyGroupSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(256).optional(),
  strategy: proxyStrategySchema,
  proxies: z.array(proxyNodeSchema).superRefine((proxies, context) => {
    if (!unique(proxies.map((proxy) => proxy.id)))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "values must be unique",
      });
  }),
});
const proxyGroupReferenceSchema = identifierSchema.nullable().optional();

const credentialAuthSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({
      type: z.literal(CredentialAuthType.ApiKey),
      api_key: secretSchema,
    }),
  ],
  { error: "must use a supported authentication type (api_key)" },
);

export const credentialSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(256).optional(),
  auth: credentialAuthSchema,
  priority: integer,
  disabled: boolean,
  proxy_group: proxyGroupReferenceSchema,
});
export const oauthCredentialSchema = credentialSchema.extend({
  auth: z.strictObject({
    type: z.literal(CredentialAuthType.OAuth),
    account_ref: z.uuid(),
  }),
});
const oauthCredentials = z
  .array(oauthCredentialSchema)
  .superRefine((credentials, context) => {
    if (!unique(credentials.map((credential) => credential.id)))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "values must be unique",
      });
    if (!unique(credentials.map((credential) => credential.auth.account_ref)))
      context.addIssue({
        code: "custom",
        path: ["auth", "account_ref"],
        message: "an account may only be attached once",
      });
  });
export const aiGatewayProviderSchema = z.strictObject({
  type: z.literal(ProviderType.AiGateway),
  id: identifierSchema,
  name: z.string().trim().min(1).max(256).optional(),
  model_settings: z
    .record(
      z.string(),
      z.strictObject({
        id: z.uuid().optional(),
        context_window: tokenCountSchema.positive().optional(),
      }),
    )
    .optional(),
  base_url: baseUrlSchema,
  proxy_group: proxyGroupReferenceSchema,
  credentials: z
    .array(credentialSchema)
    .min(1, "must be a non-empty array")
    .superRefine((credentials, context) => {
      if (!unique(credentials.map((key) => key.id)))
        context.addIssue({
          code: "custom",
          path: ["id"],
          message: "values must be unique",
        });
    }),
  models: names,
  disabled: boolean,
  priority: integer,
  supports_websocket: boolean.default(false),
  supports_web_search: boolean.default(false),
  supports_context_management: boolean.default(false),
  anthropic_1m_context: boolean.default(false),
  emulate_claude_code: boolean.default(false),
  retry: retrySchema.optional(),
  model_routes: routes(providerRouteSchema).optional(),
});
export const codexAccountSelectionSchema = z.enum(CodexAccountSelection);
export const antigravityProviderFormSchema = aiGatewayProviderSchema
  .omit({ base_url: true })
  .extend({
    type: z.literal(ProviderType.Antigravity),
    id: identifierSchema,
    sensitive_words: z
      .array(z.string().trim().min(1).max(256))
      .max(128)
      .optional(),
    account_selection: codexAccountSelectionSchema.default(
      CodexAccountSelection.RoundRobin,
    ),
    models: nameList,
    credentials: oauthCredentials,
    supports_websocket: z.literal(false).default(false),
    supports_web_search: z.literal(false).default(false),
    supports_context_management: z.literal(false).default(false),
    anthropic_1m_context: z.literal(false).default(false),
    emulate_claude_code: z.literal(false).default(false),
  });
/** Enabled native providers need models and at least one account before saving. */
function requireEnabledCredentials<
  T extends z.ZodType<{
    disabled: boolean;
    models: string[];
    credentials: unknown[];
  }>,
>(configuration: T, label: string) {
  return configuration.superRefine((provider, context) => {
    if (provider.disabled) return;
    if (!provider.models.length)
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: `select ${label} models before enabling the provider`,
      });
    if (!provider.credentials.length)
      context.addIssue({
        code: "custom",
        path: ["credentials"],
        message: `add ${label === "Antigravity" ? "an" : "a"} ${label} account before enabling the provider`,
      });
  });
}
export const antigravityProviderSchema = requireEnabledCredentials(
  antigravityProviderFormSchema,
  "Antigravity",
);
export const codexProviderFormSchema = aiGatewayProviderSchema
  .omit({ base_url: true })
  .extend({
    type: z.literal(ProviderType.Codex),
    id: identifierSchema,
    models: nameList,
    credentials: oauthCredentials,
    supports_websocket: boolean.default(true),
    supports_web_search: boolean.default(true),
    anthropic_1m_context: z.literal(false).default(false),
    emulate_claude_code: z.literal(false).default(false),
    account_selection: codexAccountSelectionSchema.default(
      CodexAccountSelection.RoundRobin,
    ),
    auto_consume_resets: boolean.default(false),
  });
export const codexProviderSchema = requireEnabledCredentials(
  codexProviderFormSchema,
  "Codex",
);
export const claudeProviderFormSchema = aiGatewayProviderSchema
  .omit({ base_url: true })
  .extend({
    models: nameList,
    credentials: oauthCredentials,
    supports_websocket: z.literal(false).default(false),
    supports_web_search: z.literal(false).default(false),
    supports_context_management: z.literal(false).default(false),
    anthropic_1m_context: z.literal(false).default(false),
    emulate_claude_code: z.literal(false).default(false),
    type: z.literal(ProviderType.Claude),
    id: identifierSchema,
    account_selection: codexAccountSelectionSchema.default(
      CodexAccountSelection.RoundRobin,
    ),
    allow_extra_usage: boolean.default(false),
  });
export const claudeProviderSchema = requireEnabledCredentials(
  claudeProviderFormSchema,
  "Claude",
);
export const xaiProviderFormSchema = claudeProviderFormSchema.extend({
  type: z.literal(ProviderType.Xai),
  id: identifierSchema,
  disabled: boolean.default(true),
  inject_x_search: boolean.default(false),
});
export const xaiProviderSchema = requireEnabledCredentials(
  xaiProviderFormSchema,
  "xAI",
);
export const providerSchema = z.discriminatedUnion("type", [
  aiGatewayProviderSchema,
  antigravityProviderSchema,
  codexProviderSchema,
  claudeProviderSchema,
  xaiProviderSchema,
]);
export const clientSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(256).optional(),
  api_key: secretSchema,
  providers: nameList,
  model_routes: routes(routeSchema).optional(),
});

function searchProvider<Mode extends keyof typeof SEARCH_PROVIDERS>(
  mode: Mode,
) {
  const defaults = SEARCH_PROVIDERS[mode];
  const message = `must be between ${defaults.maxResults.min} and ${defaults.maxResults.max} for ${mode}`;
  return z.strictObject({
    mode: z.literal(mode),
    prefer_native: boolean.default(false),
    api_key: secretSchema,
    base_url: baseUrlSchema.default(defaults.defaultBaseUrl),
    max_results: integer
      .min(defaults.maxResults.min, message)
      .max(defaults.maxResults.max, message)
      .default(defaults.maxResults.default),
  });
}
export const searchSchema = z.discriminatedUnion(
  "mode",
  [
    z.strictObject({ mode: z.literal("proxy") }),
    searchProvider("tavily"),
    searchProvider("exa"),
  ],
  { error: "must be proxy or one of: tavily, exa" },
);

const shape = z.strictObject({
  proxy_groups: z.array(proxyGroupSchema).default([]),
  providers: z.array(providerSchema, { error: "must be a non-empty array" }),
  api_keys: z.array(clientSchema, { error: "must be a non-empty array" }),
  model_routes: routes(routeSchema).default({}),
  web_search: searchSchema.default({ mode: "proxy" }),
  model_prices: modelPricesSchema.optional(),
  reporting: reportingSchema.optional(),
  revision: integer.positive().optional(),
});
type Configuration = z.output<typeof shape>;
const formShape = shape.extend({
  providers: z.array(
    z.discriminatedUnion("type", [
      aiGatewayProviderSchema,
      antigravityProviderFormSchema,
      codexProviderFormSchema,
      claudeProviderFormSchema,
      xaiProviderFormSchema,
    ]),
  ),
});

function validateIdentities(config: Configuration, context: z.RefinementCtx) {
  for (const [type, label] of [
    [ProviderType.Antigravity, "Antigravity"],
    [ProviderType.Codex, "Codex"],
    [ProviderType.Claude, "Claude"],
    [ProviderType.Xai, "xAI"],
  ] as const) {
    if (
      config.providers.filter((provider) => provider.type === type).length > 1
    )
      context.addIssue({
        code: "custom",
        path: ["providers"],
        message: `${label} is a fixed provider and may only be declared once`,
      });
  }
  for (const [path, values] of [
    [["proxy_groups", "id"], config.proxy_groups.map((group) => group.id)],
    [["providers", "id"], config.providers.map((provider) => provider.id)],
    [["api_keys", "id"], config.api_keys.map((client) => client.id)],
    [["api_keys", "api_key"], config.api_keys.map((client) => client.api_key)],
  ] as const) {
    if (!unique(values))
      context.addIssue({
        code: "custom",
        path: [...path],
        message: "values must be unique",
      });
  }
}

function validateReferences(config: Configuration, context: z.RefinementCtx) {
  const proxyGroups = new Set(config.proxy_groups.map((group) => group.id));
  const providers = new Map(
    config.providers.map((provider) => [provider.id, provider]),
  );
  const models = new Set(config.providers.flatMap(providerModelNames));
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const validateRoute = (
    route: z.output<typeof routeSchema>,
    path: (string | number)[],
  ) => {
    if (!models.has(route.model))
      issue(
        [...path, "model"],
        `targets ${route.model}, which no provider supports`,
      );
    for (const id of route.providers ?? []) {
      const provider = providers.get(id);
      if (!provider)
        issue([...path, "providers"], `references unknown provider ${id}`);
      else if (!supportsProviderModel(provider, route.model))
        issue(
          [...path, "model"],
          `${route.model} is not listed by provider ${id}`,
        );
    }
  };
  for (const [index, client] of config.api_keys.entries()) {
    for (const id of client.providers) {
      if (!providers.has(id))
        issue(
          ["api_keys", index, "providers"],
          `references unknown provider ${id}`,
        );
    }
    for (const [alias, route] of Object.entries(client.model_routes ?? {}))
      validateRoute(route, ["api_keys", index, "model_routes", alias]);
  }
  for (const [alias, route] of Object.entries(config.model_routes))
    validateRoute(route, ["model_routes", alias]);
  for (const [index, provider] of config.providers.entries()) {
    for (const [reference, path] of [
      [provider.proxy_group, ["providers", index, "proxy_group"]],
      ...provider.credentials.map(
        (credential, credentialIndex) =>
          [
            credential.proxy_group,
            ["providers", index, "credentials", credentialIndex, "proxy_group"],
          ] as const,
      ),
    ] as const) {
      if (reference && !proxyGroups.has(reference))
        issue([...path], `references unknown proxy group ${reference}`);
    }
    for (const [alias, route] of Object.entries(provider.model_routes ?? {})) {
      if (!supportsProviderModel(provider, route.model))
        issue(
          ["providers", index, "model_routes", alias, "model"],
          `${route.model} is not listed by provider ${provider.id}`,
        );
    }
  }
  validateModelPriceReferences(
    config.model_prices ?? [],
    config.providers,
    context,
  );
}

function normalize(config: Configuration) {
  for (const item of [...config.providers, ...config.api_keys]) {
    if (item.model_routes && !Object.keys(item.model_routes).length)
      delete item.model_routes;
  }
  return config;
}

/** Editable values allow unresolved references and a native provider awaiting accounts or models. */
export const editableConfigurationSchema = formShape
  .superRefine(validateIdentities)
  .transform(normalize);
/** Masked credentials are repeated placeholders, so secret uniqueness is checked only after restoration. */
export const maskedConfigurationSchema = formShape.transform(normalize);
export const configurationSchema = shape
  .superRefine(validateIdentities)
  .superRefine(validateReferences)
  .transform(normalize);

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === "number"
        ? `${text}[${key}]`
        : `${text}${text ? "." : ""}${String(key)}`,
    "",
  );
}
export function configurationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid configuration";
  const path = pathText(issue.path) || "configuration";
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    if (path === "configuration" && issue.keys.includes("protocol"))
      return "providers[0].protocol is not supported";
    if (
      path === "configuration" &&
      issue.keys.includes("providers") &&
      ["base_url"].every((name) => issue.keys.includes(name))
    )
      return "providers[0].base_url is not supported";
    if (
      path === "web_search" &&
      ["api_key", "base_url", "max_results", "prefer_native"].includes(key)
    )
      return `${path}.${key} is only supported for Tavily or Exa mode`;
    return `${path}.${key} is not supported`;
  }
  return `${path} ${issue.message}`;
}
