import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { readBodyWithinLimit } from "../gateway/http/body.ts";
import { configureLogging } from "../shared/log.ts";
import type { AdminContext } from "./context.ts";
import { serveConsoleAsset } from "./assets.ts";
import { adminError, adminSecurity, CONSOLE_CSP } from "./middleware.ts";
import { oidcRoutes } from "./oidc.ts";
import { configurationRoutes } from "./routes/configuration.ts";
import { pricingRoutes } from "./routes/pricing.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runtimeRoutes } from "./routes/runtime.ts";
import { oauthRoutes } from "./routes/oauth.ts";

function isApiPath(path: string): boolean {
  return /\/api(?:\/|$)/.test(path);
}

const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;

// Hono's bodyLimit rebuilds unsized bodies with `new Request(c.req.raw)`, which
// undici rejects for @hono/node-server's lightweight requests (bodyless DELETEs
// included), so buffer the body and rebuild the request from its parts.
const adminBodyLimit = createMiddleware<AdminContext>(async (c, next) => {
  const request = c.req.raw;
  if (!request.body) return next();
  const body = await readBodyWithinLimit(
    request.body,
    MAX_ADMIN_BODY_BYTES,
    request.headers.get("content-length"),
    undefined,
    request.signal,
  );
  c.req.raw = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
  return next();
});

const adminApi = new Hono<AdminContext>()
  .use("*", adminBodyLimit)
  .use("*", async (c, next) => {
    if (
      ["POST", "PUT", "PATCH"].includes(c.req.method) &&
      !c.req.header("content-type")?.toLowerCase().includes("application/json")
    ) {
      throw new HTTPException(415, { message: "Expected application/json" });
    }
    await next();
  })
  .route("/config", configurationRoutes)
  .route("/pricing", pricingRoutes)
  .route("/", oauthRoutes)
  .route("/", reportRoutes)
  .route("/runtime", runtimeRoutes);

export type AdminApi = typeof adminApi;

async function consoleAsset(c: Context<AdminContext>): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return c.json({ error: "Not found" }, 404);
  return serveConsoleAsset(c.req.raw, assets);
}

/** Security headers for public console assets; authenticated routes set them in `adminSecurity`. */
const publicAssetHeaders = createMiddleware<AdminContext>(async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("content-security-policy", CONSOLE_CSP);
});

export const adminApp = new Hono<AdminContext>()
  // Sign-in must be reachable before a session exists.
  .route("/auth", oidcRoutes)
  // Off Cloudflare the console bundle holds no secrets and may be public.
  .get("*", async (c, next) =>
    c.env.ADMIN_ASSETS_PUBLIC === "true" && !isApiPath(c.req.path)
      ? publicAssetHeaders(c, async () => {
          c.res = await consoleAsset(c);
        })
      : next(),
  )
  .use("*", adminSecurity)
  .use("*", async (c, next) => {
    configureLogging(c.env.LOG_LEVEL);
    await next();
  })
  .route("/api", adminApi)
  .all("/api", (c) => c.json({ error: "Not found" }, 404))
  .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
  .get("*", consoleAsset)
  .onError(adminError);
