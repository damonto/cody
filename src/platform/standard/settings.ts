import { z } from "zod";
import { databaseKind } from "./sql/connect.ts";

const text = z.string().trim().min(1);
const flag = z.enum(["true", "false"]);
const schema = z.object({
  DATABASE_URL: text,
  REDIS_URL: text
    .url()
    .refine((value) => /^rediss?:/.test(value), "Use redis:// or rediss://"),
  REDIS_PREFIX: text.default("cody"),
  CONFIG_ENCRYPTION_KEY: text.refine((value) => {
    try {
      return atob(value).length === 32;
    } catch {
      return false;
    }
  }, "Use a base64-encoded 32-byte key"),
  CONFIG_KEY: text.default("gateway-config"),
  CONFIG_CACHE_TTL_SECONDS: z.coerce
    .number()
    .min(0)
    .max(300)
    .default(10)
    .transform(String),
  MODELS_CACHE_TTL_SECONDS: z.coerce
    .number()
    .min(0)
    .max(300)
    .default(10)
    .transform(String),
  LOG_LEVEL: z.enum(["info", "warn", "error", "off", "silent"]).default("info"),
  ADMIN_AUTH_MODE: z.enum(["access", "oidc", "token", "local"]).default("oidc"),
  ADMIN_TOKEN: text.min(16).optional(),
  ADMIN_OIDC_ISSUER: text.url().optional(),
  ADMIN_OIDC_CLIENT_ID: text.optional(),
  ADMIN_OIDC_CLIENT_SECRET: text.optional(),
  ADMIN_OIDC_ALLOWED_EMAILS: text.optional(),
  ADMIN_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(2_592_000)
    .default(43_200)
    .transform(String),
  ACCESS_TEAM_DOMAIN: text.url().optional(),
  ACCESS_AUD: text.optional(),
  ADMIN_ASSETS_PUBLIC: flag.default("true"),
  HOST: text.default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  DATABASE_MIGRATE: flag.default("true"),
  CRON_SECRET: text.min(16).optional(),
});

export type StandardSettings = z.infer<typeof schema>;
export type StandardTarget = "node" | "vercel";

export function readSettings(
  source: Record<string, string | undefined>,
  target: StandardTarget,
): StandardSettings {
  const parsed = schema.safeParse({
    ...source,
    DATABASE_MIGRATE:
      source.DATABASE_MIGRATE ?? (target === "node" ? "true" : "false"),
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid runtime settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const settings = parsed.data;
  const database = databaseKind(settings.DATABASE_URL);
  if (target === "vercel" && database === "sqlite")
    throw new Error(
      "Vercel requires PostgreSQL or libSQL; local SQLite is not durable there",
    );
  if (target === "vercel" && settings.DATABASE_MIGRATE === "true") {
    throw new Error(
      "Vercel migrations run in the deployment build; leave DATABASE_MIGRATE unset or false for functions",
    );
  }
  if (
    settings.ADMIN_AUTH_MODE === "local" &&
    (target === "vercel" ||
      !["127.0.0.1", "localhost", "::1"].includes(settings.HOST))
  ) {
    throw new Error(
      "Local administrator mode requires a native Node server bound to loopback",
    );
  }
  if (settings.ADMIN_AUTH_MODE === "token" && !settings.ADMIN_TOKEN)
    throw new Error("ADMIN_TOKEN is required in token mode");
  if (
    settings.ADMIN_AUTH_MODE === "access" &&
    (!settings.ACCESS_TEAM_DOMAIN || !settings.ACCESS_AUD)
  )
    throw new Error("Access mode requires ACCESS_TEAM_DOMAIN and ACCESS_AUD");
  if (
    settings.ADMIN_AUTH_MODE === "oidc" &&
    (!settings.ADMIN_OIDC_ISSUER?.startsWith("https://") ||
      !settings.ADMIN_OIDC_CLIENT_ID ||
      !settings.ADMIN_OIDC_ALLOWED_EMAILS?.split(",").some((email) =>
        email.trim(),
      ))
  ) {
    throw new Error(
      "OIDC mode requires an HTTPS ADMIN_OIDC_ISSUER, ADMIN_OIDC_CLIENT_ID and ADMIN_OIDC_ALLOWED_EMAILS",
    );
  }
  if (target === "vercel" && !settings.CRON_SECRET)
    throw new Error("CRON_SECRET is required on Vercel");
  return settings;
}
