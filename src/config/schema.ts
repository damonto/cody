import { z } from "zod";
import {
  modelPoliciesSchema,
  reportingSchema,
  validateModelPolicyReferences,
} from "../billing/schema.ts";
import { SEARCH_PROVIDERS } from "../shared/search.ts";

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
const secretSchema = z
  .string({ error: "must be a non-empty string" })
  .trim()
  .min(1, "must be a non-empty string");
const integer = z
  .number({ error: "must be an integer" })
  .int({ error: "must be an integer" });
const boolean = z.boolean({ error: "must be a boolean" });
export const baseUrlSchema = z
  .string()
  .trim()
  .url("must be an absolute http(s) URL")
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
const names = z
  .array(nameSchema, { error: "must be a non-empty array" })
  .min(1, "must be a non-empty array")
  .refine(unique, "must not contain duplicates")
  .meta({ uniqueItems: true });
export const routeSchema = z.strictObject({
  model: nameSchema,
  services: names.optional(),
});
export const serviceRouteSchema = z.strictObject({ model: nameSchema });

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
      .refine(unique, "must not contain duplicates")
      .meta({ uniqueItems: true }),
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
      (value.status_codes.length === 0) === (value.delays_ms.length === 0),
    "status_codes and delays_ms must both be empty or both be non-empty",
  )
  .meta({
    // JSON Schema cannot derive a Zod refinement. Keep its equivalent beside the rule.
    anyOf: [
      {
        properties: {
          status_codes: { maxItems: 0 },
          delays_ms: { maxItems: 0 },
        },
      },
      {
        properties: {
          status_codes: { minItems: 1 },
          delays_ms: { minItems: 1 },
        },
      },
    ],
  });

export const credentialSchema = z.strictObject({
  id: identifierSchema,
  api_key: secretSchema,
  priority: integer,
  disabled: boolean,
});
export const serviceSchema = z.strictObject({
  id: identifierSchema,
  base_url: baseUrlSchema,
  keys: z
    .array(credentialSchema, { error: "must be a non-empty array" })
    .min(1, "must be a non-empty array")
    .superRefine((keys, context) => {
      if (!unique(keys.map((key) => key.id)))
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
  retry: retrySchema.optional(),
  model_routes: routes(serviceRouteSchema).optional(),
});
export const clientSchema = z.strictObject({
  id: identifierSchema,
  api_key: secretSchema,
  services: names,
  model_routes: routes(routeSchema).optional(),
});

function searchProvider<Mode extends keyof typeof SEARCH_PROVIDERS>(
  mode: Mode,
) {
  const defaults = SEARCH_PROVIDERS[mode];
  const message = `must be between ${defaults.maxResults.min} and ${defaults.maxResults.max} for ${mode}`;
  return z.strictObject({
    mode: z.literal(mode),
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
  $schema: z.string({ error: "must be a string" }).optional(),
  services: z.array(serviceSchema, { error: "must be a non-empty array" }),
  api_keys: z.array(clientSchema, { error: "must be a non-empty array" }),
  model_routes: routes(routeSchema).default({}),
  web_search: searchSchema.default({ mode: "proxy" }),
  model_policies: modelPoliciesSchema.optional(),
  reporting: reportingSchema.optional(),
  revision: integer.positive().optional(),
});
type Configuration = z.output<typeof shape>;

function validateIdentities(config: Configuration, context: z.RefinementCtx) {
  for (const [path, values] of [
    [["services", "id"], config.services.map((service) => service.id)],
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
  const services = new Map(
    config.services.map((service) => [service.id, service]),
  );
  const models = new Set(config.services.flatMap((service) => service.models));
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const validateRoute = (
    route: z.output<typeof routeSchema>,
    path: (string | number)[],
  ) => {
    if (!models.has(route.model))
      issue(
        [...path, "model"],
        `targets ${route.model}, which no service supports`,
      );
    for (const id of route.services ?? []) {
      const service = services.get(id);
      if (!service)
        issue([...path, "services"], `references unknown service ${id}`);
      else if (!service.models.includes(route.model))
        issue(
          [...path, "model"],
          `${route.model} is not listed by service ${id}`,
        );
    }
  };
  for (const [index, client] of config.api_keys.entries()) {
    for (const id of client.services) {
      if (!services.has(id))
        issue(
          ["api_keys", index, "services"],
          `references unknown service ${id}`,
        );
    }
    for (const [alias, route] of Object.entries(client.model_routes ?? {}))
      validateRoute(route, ["api_keys", index, "model_routes", alias]);
  }
  for (const [alias, route] of Object.entries(config.model_routes))
    validateRoute(route, ["model_routes", alias]);
  for (const [index, service] of config.services.entries()) {
    for (const [alias, route] of Object.entries(service.model_routes ?? {})) {
      if (!service.models.includes(route.model))
        issue(
          ["services", index, "model_routes", alias, "model"],
          `${route.model} is not listed by service ${service.id}`,
        );
    }
  }
  validateModelPolicyReferences(
    config.model_policies ?? [],
    config.services,
    context,
  );
}

function normalize({ $schema: _schema, ...config }: Configuration) {
  for (const item of [...config.services, ...config.api_keys]) {
    if (item.model_routes && !Object.keys(item.model_routes).length)
      delete item.model_routes;
  }
  return config;
}

/** Drafts share every structural rule, but may have unresolved references. */
export const draftConfigurationSchema = shape
  .superRefine(validateIdentities)
  .transform(normalize);
/** Masked credentials are repeated placeholders, so secret uniqueness is checked only after restoration. */
export const maskedConfigurationSchema = shape.transform(normalize);
export const configurationSchema = shape
  .extend({
    services: shape.shape.services.min(1, "must be a non-empty array"),
    api_keys: shape.shape.api_keys.min(1, "must be a non-empty array"),
  })
  .superRefine(validateIdentities)
  .superRefine(validateReferences)
  .transform(normalize)
  .meta({
    title: "Cody Gateway Configuration",
    $id: "https://example.invalid/cody.schema.json",
  });

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
    if (
      path === "web_search" &&
      ["api_key", "base_url", "max_results"].includes(key)
    )
      return `${path}.${key} is only supported for Tavily or Exa mode`;
    return `${path}.${key} is not supported`;
  }
  if (issue.path.length === 1 && issue.path[0] === "$schema")
    return `configuration.$schema ${issue.message}`;
  if (
    issue.message ===
    "status_codes and delays_ms must both be empty or both be non-empty"
  )
    return `${path}.status_codes and ${path}.delays_ms must both be empty or both be non-empty`;
  return `${path} ${issue.message}`;
}
