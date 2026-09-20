import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { configureLogging } from "../shared/log.ts";
import type { AdminContext } from "./context.ts";
import { serveConsoleAsset } from "./assets.ts";
import { adminError, adminSecurity } from "./middleware.ts";
import { configurationRoutes } from "./routes/configuration.ts";
import { pricingRoutes } from "./routes/pricing.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runtimeRoutes } from "./routes/runtime.ts";
import { oauthRoutes } from "./routes/oauth.ts";

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
export const adminApp = new Hono<AdminContext>()
  .use("*", adminSecurity)
  .use("*", async (c, next) => {
    configureLogging(c.env.LOG_LEVEL);
    await next();
  })
  .route("/api", adminApi)
  .all("/api", (c) => c.json({ error: "Not found" }, 404))
  .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
  .get("*", (c) => serveConsoleAsset(c.req.raw, c.env.ASSETS))
  .onError(adminError);
