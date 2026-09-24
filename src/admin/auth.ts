import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Bindings } from "../platform/bindings.ts";
import { equalSecret } from "../shared/equal-secret.ts";
import {
  ADMIN_LOGIN_PATH,
  authenticateOidcSession,
  publicOrigin,
} from "./oidc.ts";

const issuers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
type AdminEnv = Pick<
  Bindings,
  | "ADMIN_LOCAL_DEV"
  | "ACCESS_TEAM_DOMAIN"
  | "ACCESS_AUD"
  | "ADMIN_AUTH_MODE"
  | "ADMIN_TOKEN"
  | "CONFIG_ENCRYPTION_KEY"
  | "ADMIN_OIDC_ISSUER"
  | "ADMIN_OIDC_CLIENT_ID"
  | "ADMIN_OIDC_CLIENT_SECRET"
  | "ADMIN_OIDC_ALLOWED_EMAILS"
  | "ADMIN_SESSION_TTL_SECONDS"
>;

export type AdminAuthMode = "access" | "oidc" | "token" | "local";
const MODES: readonly AdminAuthMode[] = ["access", "oidc", "token", "local"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const MIN_TOKEN_LENGTH = 16;

/** The configured administrator authentication mode; Cloudflare Access by default. */
export function adminAuthMode(
  env: Pick<Bindings, "ADMIN_AUTH_MODE">,
): AdminAuthMode {
  const value = env.ADMIN_AUTH_MODE?.trim().toLowerCase();
  return (MODES as readonly string[]).includes(value ?? "")
    ? (value as AdminAuthMode)
    : "access";
}

function isLocalRequest(request: Request): boolean {
  return LOCAL_HOSTS.includes(new URL(request.url).hostname);
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get("x-admin-token");
  if (header) return header.trim();
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1]!.trim() : null;
}

async function authenticateToken(
  request: Request,
  env: Pick<Bindings, "ADMIN_TOKEN">,
): Promise<string | null> {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return null;
  const presented = presentedToken(request);
  if (!presented) return null;
  return (await equalSecret(presented, expected)) ? "admin-token" : null;
}

async function authenticateAccess(
  request: Request,
  env: Pick<Bindings, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const issuer = new URL(env.ACCESS_TEAM_DOMAIN).origin;
    if (
      !issuer.startsWith("https://") ||
      !new URL(issuer).hostname.endsWith(".cloudflareaccess.com")
    )
      return null;
    let jwks = issuers.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      if (issuers.size >= 8) issuers.clear();
      issuers.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    return typeof payload.email === "string"
      ? payload.email
      : typeof payload.sub === "string"
        ? payload.sub
        : "access-service";
  } catch {
    return null;
  }
}

export async function authenticateAdmin(
  request: Request,
  env: AdminEnv,
): Promise<string | null> {
  if (env.ADMIN_LOCAL_DEV === "true" && isLocalRequest(request))
    return "local-admin";
  switch (adminAuthMode(env)) {
    case "access":
      return authenticateAccess(request, env);
    case "token":
      return authenticateToken(request, env);
    case "oidc":
      return authenticateOidcSession(request, env);
    case "local":
      return isLocalRequest(request) ? "local-admin" : null;
  }
}

export interface AdminChallenge {
  readonly body: { error: string; login_url?: string };
  readonly headers: Record<string, string>;
}

/** The 401 payload and headers for an unauthenticated administrator request. */
export function adminChallenge(
  env: Pick<Bindings, "ADMIN_AUTH_MODE">,
): AdminChallenge {
  switch (adminAuthMode(env)) {
    case "access":
      return {
        body: {
          error:
            "Administrator authentication required. Configure Cloudflare Access.",
        },
        headers: {},
      };
    case "token":
      return {
        body: {
          error:
            "Administrator authentication required. Present the administrator token.",
        },
        headers: { "www-authenticate": 'Bearer realm="cody"' },
      };
    case "oidc":
      return {
        body: {
          error: "Administrator sign-in required.",
          login_url: ADMIN_LOGIN_PATH,
        },
        headers: { "www-authenticate": 'OIDC realm="cody"' },
      };
    case "local":
      return {
        body: {
          error:
            "Administrator authentication required. The console only accepts localhost requests.",
        },
        headers: {},
      };
  }
}

export function safeAdminMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("x-cody-admin") !== "1") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
