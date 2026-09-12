import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { publisherReplySchema, revisionSchema } from "../../control/schema.ts";
import { draftSchema, rollbackSchema, versionSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import type { AdminContext } from "../context.ts";

async function publisherReply(reply: Promise<string>) {
  const result = publisherReplySchema.parse(JSON.parse(await reply));
  if (!result.ok)
    throw new HTTPException(result.status, { message: result.error });
  return result.data;
}

export const configurationRoutes = new Hono<AdminContext>()
  .get("/", async (c) =>
    c.json({
      ...(await publisherReply(
        c.env.CONFIG_PUBLISHER.getByName("configuration").getDraft(),
      )),
      actor: c.get("actor"),
    }),
  )
  .put("/", validate("json", draftSchema), async (c) => {
    const input = c.req.valid("json");
    return c.json({
      ...(await publisherReply(
        c.env.CONFIG_PUBLISHER.getByName("configuration").saveDraft(
          JSON.stringify(input.config),
          input.version,
          c.get("actor"),
        ),
      )),
      actor: c.get("actor"),
    });
  })
  .post("/publish", validate("json", versionSchema), async (c) =>
    c.json({
      ...(await publisherReply(
        c.env.CONFIG_PUBLISHER.getByName("configuration").publish(
          c.req.valid("json").version,
          c.get("actor"),
        ),
      )),
      actor: c.get("actor"),
    }),
  )
  .post("/rollback", validate("json", rollbackSchema), async (c) => {
    const input = c.req.valid("json");
    return c.json({
      ...(await publisherReply(
        c.env.CONFIG_PUBLISHER.getByName("configuration").rollback(
          input.revision,
          input.version,
          c.get("actor"),
        ),
      )),
      actor: c.get("actor"),
    });
  })
  .get("/versions", async (c) => {
    const result = await c.env.CODY_DB.prepare(
      "SELECT id, created_at, published_at, actor, status, source_revision FROM config_revisions ORDER BY id DESC LIMIT 100",
    ).all();
    return c.json({ items: z.array(revisionSchema).parse(result.results) });
  });
