import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { identifierSchema } from "../../config/schema.ts";
import {
  accountReply,
  accountViewSchema,
  connectionSchema,
  OAuthError,
  sessionViewSchema,
} from "../../providers/oauth/schema.ts";
import { publishedProxyConfiguration } from "../../providers/outbound.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import { audit } from "../audit.ts";
import { controlStore, type AdminContext } from "../context.ts";
import { validate } from "../validation.ts";
import type { Bindings } from "../../platform/bindings.ts";

const startSchema = connectionSchema.extend({
  provider_id: z.literal("antigravity"),
  account_ref: z.uuid().optional(),
  version: z.number().int().nonnegative(),
});
const accountParam = z.object({ ref: z.uuid() });
const sessionParam = z.object({
  id: z.string().transform((value, context) => {
    const [account_ref, session_id, extra] = value.split(".");
    if (
      extra !== undefined ||
      !z.uuid().safeParse(account_ref).success ||
      !z.uuid().safeParse(session_id).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid authorization session",
      });
      return z.NEVER;
    }
    return { account_ref, session_id };
  }),
});
async function checkedAccount(env: Bindings, ref: string, providerId?: string) {
  const row = await env.CODY_DB.prepare(
    "SELECT provider_id FROM oauth_accounts WHERE account_ref = ?",
  )
    .bind(ref)
    .first<{ provider_id: string }>();
  if (!row || (providerId && row.provider_id !== providerId))
    throw new HTTPException(404, {
      message: "Account does not belong to this provider",
    });
  return env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
}
async function reply<T extends z.ZodType>(
  call: Parameters<typeof accountReply>[0],
  schema: T,
): Promise<z.output<T>> {
  try {
    return await accountReply(call, schema);
  } catch (error) {
    if (error instanceof OAuthError)
      throw new HTTPException(error.status as ContentfulStatusCode, {
        message: error.message,
      });
    throw error;
  }
}

export const oauthRoutes = new Hono<AdminContext>()
  .post("/oauth/sessions", validate("json", startSchema), async (c) => {
    const input = c.req.valid("json");
    const store = controlStore(c.env);
    const state = await store.state();
    if (state.draft_version !== input.version)
      throw new HTTPException(409, {
        message: "The draft changed; reload before authorizing",
      });
    const proxy =
      input.credential_proxy_group === undefined
        ? input.provider_proxy_group
        : input.credential_proxy_group;
    if (
      proxy &&
      !(await publishedProxyConfiguration(c.env)).proxy_groups.some(
        (group) => group.id === proxy,
      )
    )
      throw new HTTPException(409, {
        message: "Publish the selected proxy group before authorizing",
      });
    const ref = input.account_ref ?? crypto.randomUUID();
    const account = input.account_ref
      ? await checkedAccount(c.env, ref, input.provider_id)
      : c.env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
    const session = await reply(
      account.run({
        action: "start",
        account_ref: ref,
        actor: c.get("actor"),
        connection: connectionSchema.parse(input),
      }),
      sessionViewSchema,
    );
    await audit(c.env, c.get("actor"), `oauth_start:${ref}`);
    return c.json(session);
  })
  .get("/oauth/sessions/:id", validate("param", sessionParam), async (c) => {
    const id = c.req.valid("param").id;
    return c.json(
      await reply(
        (await checkedAccount(c.env, id.account_ref)).run({
          action: "session",
          session_id: id.session_id,
          actor: c.get("actor"),
        }),
        sessionViewSchema,
      ),
    );
  })
  .post(
    "/oauth/sessions/:id/callback",
    validate("param", sessionParam),
    validate(
      "json",
      z.strictObject({ redirect_url: z.string().min(1).max(16_384) }),
    ),
    async (c) => {
      const id = c.req.valid("param").id;
      return c.json(
        await reply(
          (await checkedAccount(c.env, id.account_ref)).run({
            action: "complete",
            session_id: id.session_id,
            actor: c.get("actor"),
            redirect_url: c.req.valid("json").redirect_url,
          }),
          sessionViewSchema,
        ),
      );
    },
  )
  .post(
    "/oauth/sessions/:id/retry",
    validate("param", sessionParam),
    validate("json", z.strictObject({})),
    async (c) => {
      const id = c.req.valid("param").id;
      return c.json(
        await reply(
          (await checkedAccount(c.env, id.account_ref)).run({
            action: "retry",
            session_id: id.session_id,
            actor: c.get("actor"),
          }),
          sessionViewSchema,
        ),
      );
    },
  )
  .delete(
    "/oauth/sessions/:id",
    validate("param", sessionParam),
    validate("json", z.strictObject({})),
    async (c) => {
      const id = c.req.valid("param").id;
      return c.json(
        await reply(
          (await checkedAccount(c.env, id.account_ref)).run({
            action: "cancel",
            session_id: id.session_id,
            actor: c.get("actor"),
          }),
          sessionViewSchema,
        ),
      );
    },
  )
  .get(
    "/provider-accounts",
    validate("query", z.object({ provider_id: identifierSchema })),
    async (c) => {
      const rows = await c.env.CODY_DB.prepare(
        "SELECT account_ref FROM oauth_accounts WHERE provider_id = ? ORDER BY created_at",
      )
        .bind(c.req.valid("query").provider_id)
        .all<{ account_ref: string }>();
      const items = await mapWithConcurrency(
        rows.results,
        PROVIDER_FAN_OUT_CONCURRENCY,
        async (row) =>
          reply(
            c.env.PROVIDER_OAUTH_ACCOUNT.getByName(row.account_ref).run({
              action: "view",
            }),
            accountViewSchema,
          ),
      );
      return c.json({ items });
    },
  )
  .get("/provider-accounts/:ref", validate("param", accountParam), async (c) =>
    c.json(
      await reply(
        (await checkedAccount(c.env, c.req.valid("param").ref)).run({
          action: "view",
        }),
        accountViewSchema,
      ),
    ),
  )
  .post(
    "/provider-accounts/quota",
    validate(
      "json",
      z.strictObject({
        account_refs: z
          .array(z.uuid())
          .min(1)
          .max(100)
          .refine(
            (refs) => new Set(refs).size === refs.length,
            "Account references must be unique",
          ),
        force: z.boolean().default(false),
      }),
    ),
    async (c) => {
      const input = c.req.valid("json");
      const results = await mapWithConcurrency(
        input.account_refs,
        PROVIDER_FAN_OUT_CONCURRENCY,
        async (ref) => {
          try {
            return {
              account_ref: ref,
              account: await reply(
                (await checkedAccount(c.env, ref)).run({
                  action: "quota",
                  force: input.force,
                }),
                accountViewSchema,
              ),
              error: null,
            };
          } catch (error) {
            return {
              account_ref: ref,
              account: null,
              error:
                error instanceof HTTPException
                  ? error.message
                  : "Account quota is unavailable",
            };
          }
        },
      );
      return c.json({ items: results });
    },
  )
  .post(
    "/provider-accounts/:ref/models",
    validate("param", accountParam),
    validate("json", z.strictObject({})),
    async (c) =>
      c.json(
        await reply(
          (await checkedAccount(c.env, c.req.valid("param").ref)).run({
            action: "models",
          }),
          accountViewSchema,
        ),
      ),
  )
  .post(
    "/provider-accounts/:ref/quota",
    validate("param", accountParam),
    validate("json", z.object({ force: z.boolean().default(false) })),
    async (c) =>
      c.json(
        await reply(
          (await checkedAccount(c.env, c.req.valid("param").ref)).run({
            action: "quota",
            force: c.req.valid("json").force,
          }),
          accountViewSchema,
        ),
      ),
  )
  .post(
    "/provider-accounts/:ref/disconnect",
    validate("param", accountParam),
    validate("json", z.strictObject({})),
    async (c) => {
      const ref = c.req.valid("param").ref;
      const result = await reply(
        (await checkedAccount(c.env, ref)).run({ action: "disconnect" }),
        accountViewSchema,
      );
      await audit(c.env, c.get("actor"), `oauth_disconnect:${ref}`);
      return c.json(result);
    },
  );
