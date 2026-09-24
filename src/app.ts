import { Hono } from "hono";
import { adminApp } from "./admin/app.ts";
import { CONSOLE_PATH } from "./admin/paths.ts";
import { gatewayRoutes } from "./gateway/app.ts";
import { gatewayNotFound } from "./gateway/handler.ts";
import type { Bindings } from "./platform/bindings.ts";

/** The runtime-neutral application shared by Workers, Node and Vercel. */
export const app = new Hono<{ Bindings: Bindings }>()
  .route("/", gatewayRoutes)
  .get("/", (c) =>
    c.redirect(`${CONSOLE_PATH}/${new URL(c.req.url).search}`, 302),
  )
  .get(CONSOLE_PATH, (c) =>
    c.redirect(`${CONSOLE_PATH}/${new URL(c.req.url).search}`, 308),
  )
  .route(CONSOLE_PATH, adminApp)
  .all("*", gatewayNotFound);
