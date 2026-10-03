import { Hono } from "hono";
import { rollbackSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { controlStore, type AdminContext } from "../context.ts";

export const configurationRoutes = new Hono<AdminContext>()
  .get("/", async (c) =>
    c.json({ ...(await controlStore(c.env).state()), actor: c.get("actor") }),
  )
  .get("/names", async (c) =>
    c.json({ names: await controlStore(c.env).names() }),
  )
  .post("/restorations", validate("json", rollbackSchema), async (c) => {
    const input = c.req.valid("json");
    return c.json({
      ...(await controlStore(c.env).restore(
        input.revision,
        input.version,
        c.get("actor"),
        input.operation_id,
      )),
      actor: c.get("actor"),
    });
  })
  .get("/versions", async (c) =>
    c.json({ items: await controlStore(c.env).versions() }),
  );
