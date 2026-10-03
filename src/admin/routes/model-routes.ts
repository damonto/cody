import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { RoutingService } from "../../control/services/routing.ts";
import { clientSchema } from "../../config/schema.ts";
const service = (c: Context<AdminContext>) =>
  new RoutingService(controlStore(c.env));
const body = configurationOperationSchema.extend({
  routes: clientSchema.shape.model_routes.unwrap(),
});
export const modelRouteRoutes = new Hono<AdminContext>()
  .get("/", async (c) => {
    return c.json(await service(c).list());
  })
  .put("/", validate("json", body), async (c) => {
    return c.json(
      await service(c).save(
        operation(c, c.req.valid("json")),
        c.req.valid("json").routes,
      ),
    );
  });
