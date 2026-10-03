import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { ProviderService } from "../../control/services/providers.ts";
import { z } from "zod";
import { nativeTypeSchema, nativeSettingsSchema } from "../resource-schema.ts";
const service = (c: Context<AdminContext>) =>
  new ProviderService(controlStore(c.env));
const params = z.object({ type: nativeTypeSchema });
const body = configurationOperationSchema.extend({
  settings: nativeSettingsSchema,
});
export const nativeProviderRoutes = new Hono<AdminContext>()
  .get("/:type", validate("param", params), async (c) => {
    return c.json(await service(c).native(c.req.valid("param").type));
  })
  .put(
    "/:type",
    validate("param", params),
    validate("json", body),
    async (c) => {
      return c.json(
        await service(c).saveNative(
          operation(c, c.req.valid("json")),
          c.req.valid("param").type,
          c.req.valid("json").settings,
        ),
      );
    },
  );
