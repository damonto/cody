import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { PricingService } from "../../control/services/pricing.ts";
import { modelPriceSchema } from "../../billing/schema.ts";
import { resourceIdSchema } from "../resource-schema.ts";
const service = (c: Context<AdminContext>) =>
  new PricingService(controlStore(c.env));
const body = configurationOperationSchema.extend({
  pricing: modelPriceSchema.shape.pricing.unwrap(),
});
export const modelPriceRoutes = new Hono<AdminContext>()
  .get("/", async (c) => {
    return c.json(await service(c).list());
  })
  .put(
    "/:id/family",
    validate("param", resourceIdSchema),
    validate("json", body),
    async (c) =>
      c.json(
        await service(c).saveFamily(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("json").pricing,
        ),
      ),
  )
  .delete(
    "/:id/family",
    validate("param", resourceIdSchema),
    validate("json", configurationOperationSchema),
    async (c) =>
      c.json(
        await service(c).saveFamily(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          null,
        ),
      ),
  )
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
          c.req.valid("param").id,
          c.req.valid("json").pricing,
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
  );
