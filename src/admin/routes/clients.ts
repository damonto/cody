import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema, versionSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { ClientService } from "../../control/services/clients.ts";
import { clientSchema } from "../../config/schema.ts";
import { clientInputSchema, resourceIdSchema } from "../resource-schema.ts";
const service = (c: Context<AdminContext>) =>
  new ClientService(controlStore(c.env));
const body = configurationOperationSchema.extend({ client: clientInputSchema });
const routesBody = configurationOperationSchema.extend({
  routes: clientSchema.shape.model_routes.unwrap(),
});
export const clientRoutes = new Hono<AdminContext>()
  .get("/", async (c) => {
    return c.json(await service(c).list());
  })
  .post("/", validate("json", body), async (c) => {
    const result = await service(c).save(
      operation(c, c.req.valid("json")),
      c.req.valid("json").client,
    );
    c.header("Location", `/console/api/clients/${result.item.id}`);
    return c.json(result, 201);
  })
  .get("/:id", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).get(c.req.valid("param").id));
  })
  .put(
    "/:id",
    validate("param", resourceIdSchema),
    validate("json", body),
    async (c) => {
      return c.json(
        await service(c).save(
          operation(c, c.req.valid("json")),
          c.req.valid("json").client,
          c.req.valid("param").id,
        ),
      );
    },
  )
  .delete(
    "/:id",
    validate("param", resourceIdSchema),
    validate("json", configurationOperationSchema),
    async (c) => {
      return c.json(
        await service(c).remove(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
        ),
      );
    },
  )
  .post(
    "/:id/reveal",
    validate("param", resourceIdSchema),
    validate("json", versionSchema),
    async (c) => {
      return c.json(
        await service(c).reveal(
          c.req.valid("param").id,
          c.req.valid("json").version,
        ),
      );
    },
  )
  .get("/:id/model-routes", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).routes(c.req.valid("param").id));
  })
  .put(
    "/:id/model-routes",
    validate("param", resourceIdSchema),
    validate("json", routesBody),
    async (c) => {
      return c.json(
        await service(c).saveRoutes(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("json").routes,
        ),
      );
    },
  );
