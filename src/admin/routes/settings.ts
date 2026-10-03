import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema, versionSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { SettingsService } from "../../control/services/settings.ts";
import { reportingSchema } from "../../billing/schema.ts";
import { searchSchema } from "../../config/schema.ts";
const service = (c: Context<AdminContext>) =>
  new SettingsService(controlStore(c.env));
const reportingBody = configurationOperationSchema.extend({
  reporting: reportingSchema,
});
const searchBody = configurationOperationSchema.extend({
  web_search: searchSchema,
});
export const settingsRoutes = new Hono<AdminContext>()
  .get("/reporting", async (c) => {
    return c.json(await service(c).reporting());
  })
  .put("/reporting", validate("json", reportingBody), async (c) => {
    return c.json(
      await service(c).saveReporting(
        operation(c, c.req.valid("json")),
        c.req.valid("json").reporting,
      ),
    );
  })
  .get("/web-search", async (c) => {
    return c.json(await service(c).search());
  })
  .put("/web-search", validate("json", searchBody), async (c) => {
    return c.json(
      await service(c).saveSearch(
        operation(c, c.req.valid("json")),
        c.req.valid("json").web_search,
      ),
    );
  })
  .post("/web-search/reveal", validate("json", versionSchema), async (c) => {
    return c.json(await service(c).revealSearch(c.req.valid("json").version));
  });
