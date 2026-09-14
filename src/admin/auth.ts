import { createRemoteJWKSet, jwtVerify } from "jose";

const issuers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
type AdminEnv = Pick<
  Env,
  "ADMIN_LOCAL_DEV" | "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD"
>;

export async function authenticateAdmin(
  request: Request,
  env: AdminEnv,
): Promise<string | null> {
  const host = new URL(request.url).hostname;
  if (
    env.ADMIN_LOCAL_DEV === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(host)
  )
    return "local-admin";
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

export function safeAdminMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("x-cody-admin") !== "1") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
