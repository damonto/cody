import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { draftConfigurationSchema } from "../../config/schema.ts";
import { publisherReplySchema, revisionSchema } from "../../control/schema.ts";
import {
  apiKeySchema,
  clientIdSchema,
  draftSchema,
  rollbackSchema,
  serviceKeyIdSchema,
  versionSchema,
} from "../schema.ts";
import { validate } from "../validation.ts";
import { controlStore, type AdminContext } from "../context.ts";

async function publisherReply(reply: Promise<string>) {
  const result = publisherReplySchema.parse(JSON.parse(await reply));
  if (!result.ok)
    throw new HTTPException(result.status, { message: result.error });
  return result.data;
}

async function credentialDraft(env: Env, version: number) {
  const store = controlStore(env);
  const state = await store.state();
  if (state.draft_version !== version)
    throw new HTTPException(409, {
      message: "The draft changed; reload before viewing this key",
    });
  return draftConfigurationSchema.parse(
    await store.rawDraft(Promise.resolve(state)),
  );
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
  .post(
    "/clients/:id/reveal",
    validate("param", clientIdSchema),
    validate("json", versionSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const config = await credentialDraft(c.env, version);
      const client = config.api_keys.find((entry) => entry.id === id);
      if (!client)
        throw new HTTPException(404, { message: "Client does not exist" });
      return c.json(apiKeySchema.parse({ api_key: client.api_key }));
    },
  )
  .post(
    "/services/:id/keys/:keyId/reveal",
    validate("param", serviceKeyIdSchema),
    validate("json", versionSchema),
    async (c) => {
      const { id, keyId } = c.req.valid("param");
      const config = await credentialDraft(c.env, c.req.valid("json").version);
      const service = config.services.find((entry) => entry.id === id);
      const key = service?.keys.find((entry) => entry.id === keyId);
      if (!key)
        throw new HTTPException(404, { message: "Service key does not exist" });
      return c.json(apiKeySchema.parse({ api_key: key.api_key }));
    },
  )
  .post("/web-search/reveal", validate("json", versionSchema), async (c) => {
    const config = await credentialDraft(c.env, c.req.valid("json").version);
    if (config.web_search.mode === "proxy")
      throw new HTTPException(404, {
        message: "No search provider key is configured",
      });
    return c.json(apiKeySchema.parse({ api_key: config.web_search.api_key }));
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
