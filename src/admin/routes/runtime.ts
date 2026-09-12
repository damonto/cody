import { Hono, type Context, type ExecutionContext } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { gatewayApp } from "../../gateway/app.ts";
import { publishedConfig, type AdminContext } from "../context.ts";
import {
  healthListSchema,
  runtimeQuerySchema,
  sessionListSchema,
} from "../schema.ts";
import { validate } from "../validation.ts";
const runtimeErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

async function runtime(
  request: Request,
  env: Env,
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
    await env.CODY_DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor, action) VALUES (?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        actor,
        `clear_${path.startsWith("health") ? "health" : "session"}`,
      )
      .run();
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
  .get("/clients", async (c) => {
    const config = await publishedConfig(c.env);
    return c.json({
      items: config?.api_keys.map((client) => ({ id: client.id })) ?? [],
    });
  })
  .get("/health", validate("query", runtimeQuerySchema), async (c) =>
    c.json(healthListSchema.parse(await (await call(c, "health")).json())),
  )
  .delete("/health/:id/:key", validate("query", runtimeQuerySchema), (c) =>
    clear(
      c,
      `health/${encodeURIComponent(c.req.param("id"))}/${encodeURIComponent(c.req.param("key"))}`,
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
