import { Hono, type Context, type ExecutionContext } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { identifierSchema } from "../../config/schema.ts";
import { gatewayApp } from "../../gateway/app.ts";
import { proxyGroupSnapshot } from "../../gateway/proxies/configuration.ts";
import { proxyGroupsStatusSchema } from "../../gateway/proxies/schema.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import { audit } from "../audit.ts";
import { publishedConfig, type AdminContext } from "../context.ts";
import {
  healthListSchema,
  runtimeQuerySchema,
  sessionListSchema,
} from "../schema.ts";
import { validate } from "../validation.ts";
import type { Bindings } from "../../platform/bindings.ts";
const runtimeErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

async function runtime(
  request: Request,
  env: Bindings,
  path: string,
  actor: string,
  executionContext: ExecutionContext,
): Promise<Response> {
  const config = await publishedConfig(env);
  if (!config)
    throw new HTTPException(409, { message: "Publish a configuration first" });
  const incoming = new URL(request.url);
  const client = config.api_keys.find(
    (entry) => entry.id === incoming.searchParams.get("client_id"),
  );
  if (!client)
    throw new HTTPException(400, { message: "Select a published client" });
  const url = new URL(`https://cody.internal/v1/${path}`);
  for (const name of [
    "scope",
    "cursor",
    "limit",
    "release_context_ownership",
  ] as const) {
    const value = incoming.searchParams.get(name);
    if (value) url.searchParams.set(name, value);
  }
  const response = await gatewayApp.fetch(
    new Request(url, {
      method: request.method,
      headers: { authorization: `Bearer ${client.api_key}` },
    }),
    env,
    executionContext,
  );
  if (request.method === "DELETE" && response.ok) {
    await audit(
      env,
      actor,
      `clear_${path.startsWith("health") ? "health" : "session"}`,
    );
  }
  if (!response.ok) {
    const error = runtimeErrorSchema.safeParse(await response.json());
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: error.success
        ? error.data.error.message
        : "Runtime operation failed",
    });
  }
  return response;
}

async function call(c: Context<AdminContext>, path: string) {
  return runtime(c.req.raw, c.env, path, c.get("actor"), c.executionCtx);
}
async function clear(c: Context<AdminContext>, path: string) {
  const response = await call(c, path);
  await response.arrayBuffer();
  return c.json({ ok: true as const });
}
export const runtimeRoutes = new Hono<AdminContext>()
  .get("/proxy-groups", async (c) => {
    const config = await publishedConfig(c.env);
    if (!config) return c.json(proxyGroupsStatusSchema.parse({ items: [] }));
    const items = await mapWithConcurrency(
      config.proxy_groups,
      PROVIDER_FAN_OUT_CONCURRENCY,
      async (group) =>
        c.env.PROXY_GROUP.getByName(group.id).getStatus(
          await proxyGroupSnapshot(config, group),
        ),
    );
    return c.json(proxyGroupsStatusSchema.parse({ items }));
  })
  .delete(
    "/proxy-groups/:groupId/proxies/:proxyId/health",
    validate(
      "param",
      z.object({ groupId: identifierSchema, proxyId: identifierSchema }),
    ),
    async (c) => {
      const { groupId, proxyId } = c.req.valid("param");
      const config = await publishedConfig(c.env);
      const group = config?.proxy_groups.find((entry) => entry.id === groupId);
      if (
        !config ||
        !group ||
        !group.proxies.some((proxy) => proxy.id === proxyId)
      )
        throw new HTTPException(404, {
          message: "Published proxy does not exist",
        });
      await c.env.PROXY_GROUP.getByName(groupId).clear(
        await proxyGroupSnapshot(config, group),
        proxyId,
      );
      await audit(
        c.env,
        c.get("actor"),
        `clear_proxy_health:${groupId}:${proxyId}`,
      );
      return c.json({ ok: true as const });
    },
  )
  .get("/clients", async (c) => {
    const config = await publishedConfig(c.env);
    return c.json({
      items: config?.api_keys.map((client) => ({ id: client.id })) ?? [],
    });
  })
  .get("/health", validate("query", runtimeQuerySchema), async (c) =>
    c.json(healthListSchema.parse(await (await call(c, "health")).json())),
  )
  .delete(
    "/health/:id/:credentialId",
    validate("query", runtimeQuerySchema),
    (c) =>
      clear(
        c,
        `health/${encodeURIComponent(c.req.param("id"))}/${encodeURIComponent(c.req.param("credentialId"))}`,
      ),
  )
  .delete("/health/:id", validate("query", runtimeQuerySchema), (c) =>
    clear(c, `health/${encodeURIComponent(c.req.param("id"))}`),
  )
  .get("/sessions", validate("query", runtimeQuerySchema), async (c) =>
    c.json(sessionListSchema.parse(await (await call(c, "sessions")).json())),
  )
  .delete("/sessions", validate("query", runtimeQuerySchema), (c) =>
    clear(c, "sessions"),
  )
  .delete("/sessions/:id", validate("query", runtimeQuerySchema), (c) =>
    clear(c, `sessions/${encodeURIComponent(c.req.param("id"))}`),
  );
