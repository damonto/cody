/**
 * OpenID Connect administrator sign-in for the standard (Node/Vercel)
 * backend. Cloudflare deployments keep Cloudflare Access; this module is only
 * consulted when `ADMIN_AUTH_MODE=oidc`.
 *
 * The flow is the standard authorization-code grant with PKCE. Transient login
 * state and the resulting administrator session are encrypted JWTs (`dir` +
 * A256GCM) under keys derived with HKDF from `CONFIG_ENCRYPTION_KEY`, so the
 * configuration key itself never encrypts cookies directly.
 *
 * This module must stay runtime-neutral: Web Crypto, `fetch`, and `jose` only.
 */
import { Hono } from "hono";
import {
  EncryptJWT,
  base64url,
  createRemoteJWKSet,
  customFetch,
  jwtDecrypt,
  jwtVerify,
} from "jose";
import { z } from "zod";
import { readBodyWithinLimit } from "../gateway/http/body.ts";
import type { Bindings } from "../platform/bindings.ts";
import { CONSOLE_PATH } from "./paths.ts";

export const ADMIN_SESSION_COOKIE = "cody_admin_session";
export const ADMIN_LOGIN_COOKIE = "cody_admin_login";
export const ADMIN_LOGIN_PATH = `${CONSOLE_PATH}/auth/login`;
const CALLBACK_PATH = `${CONSOLE_PATH}/auth/callback`;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const SESSION_AUDIENCE = "cody-admin-session";
const LOGIN_AUDIENCE = "cody-admin-login";
const TOKEN_ISSUER = "cody-admin";
const MAX_OIDC_RESPONSE_BYTES = 1024 * 1024;

export type OidcEnv = Pick<
  Bindings,
  | "CONFIG_ENCRYPTION_KEY"
  | "ADMIN_OIDC_ISSUER"
  | "ADMIN_OIDC_CLIENT_ID"
  | "ADMIN_OIDC_CLIENT_SECRET"
  | "ADMIN_OIDC_ALLOWED_EMAILS"
  | "ADMIN_SESSION_TTL_SECONDS"
>;

export interface AdminIdentity {
  readonly sub: string;
  readonly email?: string | undefined;
}

export interface OidcTransport {
  /** Used for discovery, token exchange, and JWKS retrieval. */
  readonly fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Key derivation and encrypted cookies
// ---------------------------------------------------------------------------

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  let material: Uint8Array<ArrayBuffer>;
  try {
    material = Uint8Array.from(atob(secret), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  if (material.byteLength !== 32)
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return material;
}

const derivedKeys = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

async function deriveKey(
  secret: string,
  info: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cacheKey = `${info}\n${secret}`;
  let pending = derivedKeys.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const base = await crypto.subtle.importKey(
        "raw",
        secretBytes(secret),
        "HKDF",
        false,
        ["deriveBits"],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(info),
        },
        base,
        256,
      );
      return new Uint8Array(bits);
    })();
    if (derivedKeys.size >= 8) derivedKeys.clear();
    derivedKeys.set(cacheKey, pending);
    pending.catch(() => derivedKeys.delete(cacheKey));
  }
  return pending;
}

async function seal(
  secret: string,
  info: string,
  audience: string,
  claims: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + Math.floor(ttlSeconds))
    .encrypt(await deriveKey(secret, info));
}

async function open<T>(
  secret: string,
  info: string,
  audience: string,
  token: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const { payload } = await jwtDecrypt(token, await deriveKey(secret, info), {
      issuer: TOKEN_ISSUER,
      audience,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    const result = schema.safeParse(payload);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const sessionSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1).optional(),
  oidc_issuer: z.string(),
  oidc_client: z.string(),
});

const loginSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  code_verifier: z.string().min(43),
  return_to: z.string().min(1),
});

export function sessionTtlSeconds(env: OidcEnv): number {
  const value = Number(env.ADMIN_SESSION_TTL_SECONDS);
  return Number.isFinite(value) && value >= 60 && value <= 30 * 24 * 60 * 60
    ? Math.floor(value)
    : DEFAULT_SESSION_TTL_SECONDS;
}

/** Issues an administrator session cookie value for an authenticated identity. */
export async function mintAdminSession(
  env: OidcEnv,
  identity: AdminIdentity,
  options: { ttlSeconds?: number } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: identity.sub,
    oidc_issuer: env.ADMIN_OIDC_ISSUER ?? "",
    oidc_client: env.ADMIN_OIDC_CLIENT_ID ?? "",
  };
  if (identity.email) claims.email = identity.email.toLowerCase();
  return seal(
    env.CONFIG_ENCRYPTION_KEY,
    "cody-admin-session",
    SESSION_AUDIENCE,
    claims,
    options.ttlSeconds ?? sessionTtlSeconds(env),
  );
}

export function allowedEmails(env: OidcEnv): Set<string> | null {
  const raw = env.ADMIN_OIDC_ALLOWED_EMAILS?.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function identityAllowed(env: OidcEnv, identity: AdminIdentity): boolean {
  const allowed = allowedEmails(env);
  if (!allowed) return true;
  return !!identity.email && allowed.has(identity.email.toLowerCase());
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Resolves the administrator actor from the OIDC session cookie, if valid. */
export async function authenticateOidcSession(
  request: Request,
  env: OidcEnv,
): Promise<string | null> {
  const cookie = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!cookie || !env.CONFIG_ENCRYPTION_KEY) return null;
  const session = await open(
    env.CONFIG_ENCRYPTION_KEY,
    "cody-admin-session",
    SESSION_AUDIENCE,
    cookie,
    sessionSchema,
  );
  if (!session) return null;
  if (
    session.oidc_issuer !== (env.ADMIN_OIDC_ISSUER ?? "") ||
    session.oidc_client !== (env.ADMIN_OIDC_CLIENT_ID ?? "")
  )
    return null;
  if (!identityAllowed(env, session)) return null;
  return session.email ?? session.sub;
}

// ---------------------------------------------------------------------------
// Provider discovery
// ---------------------------------------------------------------------------

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "OIDC endpoints must use https",
  });

const metadataSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  jwks_uri: httpsUrl,
});

type ProviderMetadata = z.infer<typeof metadataSchema>;

interface DiscoveryEntry {
  readonly expires: number;
  readonly metadata: ProviderMetadata;
  readonly jwks: ReturnType<typeof createRemoteJWKSet>;
}

const discovery = new Map<string, Promise<DiscoveryEntry>>();

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<ProviderMetadata & { jwks: DiscoveryEntry["jwks"] }> {
  const normalized = normalizeIssuer(issuer);
  const cached = discovery.get(normalized);
  if (cached) {
    const entry = await cached.catch(() => null);
    if (entry && entry.expires > Date.now())
      return { ...entry.metadata, jwks: entry.jwks };
    discovery.delete(normalized);
  }
  const pending = (async (): Promise<DiscoveryEntry> => {
    const response = await fetchImpl(
      `${normalized}/.well-known/openid-configuration`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`OIDC discovery failed with status ${response.status}`);
    const metadata = metadataSchema.parse(await response.json());
    if (normalizeIssuer(metadata.issuer) !== normalized)
      throw new Error("OIDC discovery returned a different issuer");
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
      [customFetch]: fetchImpl,
    });
    return { expires: Date.now() + DISCOVERY_TTL_MS, metadata, jwks };
  })();
  if (discovery.size >= 8) discovery.clear();
  discovery.set(normalized, pending);
  pending.catch(() => discovery.delete(normalized));
  const entry = await pending;
  return { ...entry.metadata, jwks: entry.jwks };
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

function randomToken(bytes = 32): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url.encode(new Uint8Array(digest));
}

/** Public origin of the request, honoring a reverse proxy's TLS termination. */
export function publicOrigin(request: Request): URL {
  const url = new URL(request.url);
  const proto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (proto === "https" && url.protocol === "http:") url.protocol = "https:";
  return url;
}

/** Only same-origin paths inside the console are honored as return targets. */
export function safeReturnTo(value: string | null | undefined): string {
  const fallback = `${CONSOLE_PATH}/`;
  if (!value) return fallback;
  if (!value.startsWith(CONSOLE_PATH)) return fallback;
  if (value.startsWith("//") || value.includes("\\")) return fallback;
  const rest = value.slice(CONSOLE_PATH.length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?"))
    return fallback;
  if (value.startsWith(`${CONSOLE_PATH}/auth/`)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://cody.invalid");
  } catch {
    return fallback;
  }
  if (parsed.origin !== "https://cody.invalid") return fallback;
  if (
    parsed.pathname !== CONSOLE_PATH &&
    !parsed.pathname.startsWith(`${CONSOLE_PATH}/`)
  )
    return fallback;
  if (parsed.pathname.startsWith(`${CONSOLE_PATH}/auth/`)) return fallback;
  return `${parsed.pathname}${parsed.search}`;
}

function cookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${CONSOLE_PATH}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearedCookie(name: string, secure: boolean): string {
  return cookie(name, "", { maxAge: 0, secure });
}

function sameSiteRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

function configured(env: OidcEnv): {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
} | null {
  const issuer = env.ADMIN_OIDC_ISSUER?.trim();
  const clientId = env.ADMIN_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId || !env.CONFIG_ENCRYPTION_KEY) return null;
  try {
    if (new URL(issuer).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const clientSecret = env.ADMIN_OIDC_CLIENT_SECRET?.trim();
  return {
    issuer: normalizeIssuer(issuer),
    clientId,
    clientSecret: clientSecret ? clientSecret : undefined,
  };
}

type OidcContext = { Bindings: Bindings };

/**
 * Builds the `/console/auth` sub-application. The transport is injectable so
 * tests can stub discovery, token exchange, and JWKS retrieval.
 */
export function createOidcApp(transport: OidcTransport = {}) {
  const send: typeof fetch =
    transport.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await send(input, init);
    // Discovery, token responses and JOSE's JWKS fetch all cross this boundary.
    const bytes = await readBodyWithinLimit(
      response.body,
      MAX_OIDC_RESPONSE_BYTES,
      response.headers.get("content-length"),
      undefined,
      init?.signal ?? (input instanceof Request ? input.signal : undefined),
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(
      [204, 205, 304].includes(response.status) ? null : bytes,
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  };
  const app = new Hono<OidcContext>();
  app.use("*", async (c, next) => {
    if (c.env.ADMIN_AUTH_MODE !== "oidc") return c.notFound();
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    await next();
    return undefined;
  });

  app.get("/login", async (c) => {
    const settings = configured(c.env);
    if (!settings)
      return c.json(
        { error: "OIDC administrator sign-in is not configured" },
        503,
      );
    const request = c.req.raw;
    const origin = publicOrigin(request);
    const returnTo = safeReturnTo(c.req.query("return_to"));
    let metadata: Awaited<ReturnType<typeof discover>>;
    try {
      metadata = await discover(settings.issuer, fetchImpl);
    } catch (error) {
      console.error({
        event: "admin.oidc.discovery.failed",
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return c.json({ error: "The identity provider is unavailable" }, 502);
    }
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    const login = await seal(
      c.env.CONFIG_ENCRYPTION_KEY,
      "cody-admin-login",
      LOGIN_AUDIENCE,
      { state, nonce, code_verifier: codeVerifier, return_to: returnTo },
      LOGIN_TTL_SECONDS,
    );
    const target = new URL(metadata.authorization_endpoint);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", settings.clientId);
    target.searchParams.set("redirect_uri", `${origin.origin}${CALLBACK_PATH}`);
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("state", state);
    target.searchParams.set("nonce", nonce);
    target.searchParams.set(
      "code_challenge",
      await pkceChallenge(codeVerifier),
    );
    target.searchParams.set("code_challenge_method", "S256");
    c.header(
      "set-cookie",
      cookie(ADMIN_LOGIN_COOKIE, login, {
        maxAge: LOGIN_TTL_SECONDS,
        secure: origin.protocol === "https:",
      }),
    );
    return c.redirect(target.href, 302);
  });

  app.get("/callback", async (c) => {
    const settings = configured(c.env);
    if (!settings)
      return c.json(
        { error: "OIDC administrator sign-in is not configured" },
        503,
      );
    const request = c.req.raw;
    const origin = publicOrigin(request);
    const secure = origin.protocol === "https:";
    const clearLogin = () =>
      c.header("set-cookie", clearedCookie(ADMIN_LOGIN_COOKIE, secure));
    const loginCookie = readCookie(request, ADMIN_LOGIN_COOKIE);
    const login = loginCookie
      ? await open(
          c.env.CONFIG_ENCRYPTION_KEY,
          "cody-admin-login",
          LOGIN_AUDIENCE,
          loginCookie,
          loginSchema,
        )
      : null;
    if (!login) {
      clearLogin();
      return c.json(
        {
          error: "The sign-in attempt expired. Start again.",
          login_url: ADMIN_LOGIN_PATH,
        },
        400,
      );
    }
    const providerError = c.req.query("error");
    if (providerError) {
      clearLogin();
      return c.json(
        {
          error: "The identity provider rejected the sign-in",
          login_url: ADMIN_LOGIN_PATH,
        },
        400,
      );
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state || state !== login.state) {
      clearLogin();
      return c.json(
        {
          error: "The sign-in state did not match. Start again.",
          login_url: ADMIN_LOGIN_PATH,
        },
        400,
      );
    }

    let identity: AdminIdentity;
    try {
      const metadata = await discover(settings.issuer, fetchImpl);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${origin.origin}${CALLBACK_PATH}`,
        client_id: settings.clientId,
        code_verifier: login.code_verifier,
      });
      const headers = new Headers({
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      });
      if (settings.clientSecret) {
        headers.set(
          "authorization",
          `Basic ${btoa(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`)}`,
        );
      }
      const exchange = await fetchImpl(metadata.token_endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!exchange.ok)
        throw new Error(`Token exchange failed with status ${exchange.status}`);
      const tokens = tokenResponseSchema.parse(await exchange.json());
      const { payload } = await jwtVerify(tokens.id_token, metadata.jwks, {
        issuer: metadata.issuer,
        audience: settings.clientId,
      });
      if (payload.nonce !== login.nonce)
        throw new Error("ID token nonce mismatch");
      if (typeof payload.sub !== "string" || !payload.sub)
        throw new Error("ID token is missing sub");
      if (allowedEmails(c.env) && payload.email_verified !== true)
        throw new Error("Administrator email is not verified");
      identity = {
        sub: payload.sub,
        ...(typeof payload.email === "string" && payload.email
          ? { email: payload.email.toLowerCase() }
          : {}),
      };
    } catch (error) {
      console.error({
        event: "admin.oidc.callback.failed",
        name: error instanceof Error ? error.name : "UnknownError",
      });
      clearLogin();
      return c.json(
        {
          error: "Sign-in could not be completed. Start again.",
          login_url: ADMIN_LOGIN_PATH,
        },
        401,
      );
    }
    if (!identityAllowed(c.env, identity)) {
      clearLogin();
      return c.json(
        { error: "This account is not allowed to administer Cody" },
        403,
      );
    }
    const ttl = sessionTtlSeconds(c.env);
    const session = await mintAdminSession(c.env, identity, {
      ttlSeconds: ttl,
    });
    c.header("set-cookie", clearedCookie(ADMIN_LOGIN_COOKIE, secure), {
      append: true,
    });
    c.header(
      "set-cookie",
      cookie(ADMIN_SESSION_COOKIE, session, { maxAge: ttl, secure }),
      { append: true },
    );
    return c.redirect(login.return_to, 302);
  });

  app.post("/logout", (c) => {
    if (!sameSiteRequest(c.req.raw))
      return c.json({ error: "Invalid admin request origin" }, 403);
    const secure = publicOrigin(c.req.raw).protocol === "https:";
    c.header("set-cookie", clearedCookie(ADMIN_SESSION_COOKIE, secure), {
      append: true,
    });
    c.header("set-cookie", clearedCookie(ADMIN_LOGIN_COOKIE, secure), {
      append: true,
    });
    return c.json({ ok: true, login_url: ADMIN_LOGIN_PATH });
  });

  return app;
}

export const oidcRoutes = createOidcApp();

/** Test hook: forgets cached discovery documents. */
export function resetOidcDiscoveryForTests(): void {
  discovery.clear();
}
