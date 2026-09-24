import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
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

const adminApi = new Hono<AdminContext>()
  .use(
    "*",
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request exceeds 2 MiB" }, 413),
    }),
  )
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
