import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema, versionSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { ProviderService } from "../../control/services/providers.ts";
import { z } from "zod";
import { aiGatewayProviderSchema } from "../../config/schema.ts";
import { tokenCountSchema } from "../../billing/schema.ts";
import {
  credentialInputSchema,
  orderSchema,
  providerCredentialParams,
  providerInputSchema,
  resourceIdSchema,
} from "../resource-schema.ts";
const service = (c: Context<AdminContext>) =>
  new ProviderService(controlStore(c.env));
const providerBody = configurationOperationSchema.extend({
  provider: providerInputSchema,
});
const credentialBody = configurationOperationSchema.extend({
  credential: credentialInputSchema,
});
const routesBody = configurationOperationSchema.extend({
  routes: aiGatewayProviderSchema.shape.model_routes.unwrap(),
});
const modelParams = z.object({ id: z.uuid(), modelId: z.uuid() });
const modelBody = configurationOperationSchema.extend({
  settings: z.strictObject({
    context_window: tokenCountSchema.positive().nullable(),
  }),
});
export const providerRoutes = new Hono<AdminContext>()
  .get("/", async (c) => {
    return c.json(await service(c).list());
  })
  .post("/", validate("json", providerBody), async (c) => {
    const result = await service(c).create(
      operation(c, c.req.valid("json")),
      c.req.valid("json").provider,
    );
    c.header("Location", `/console/api/providers/${result.item.id}`);
    return c.json(result, 201);
  })
  .put("/order", validate("json", orderSchema), async (c) => {
    return c.json(
      await service(c).order(
        operation(c, c.req.valid("json")),
        c.req.valid("json").ids,
      ),
    );
  })
  .get("/:id", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).get(c.req.valid("param").id));
  })
  .put(
    "/:id",
    validate("param", resourceIdSchema),
    validate("json", providerBody),
    async (c) => {
      return c.json(
        await service(c).update(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("json").provider,
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
  .get("/:id/credentials", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).credentials(c.req.valid("param").id));
  })
  .post(
    "/:id/credentials",
    validate("param", resourceIdSchema),
    validate("json", credentialBody),
    async (c) => {
      const result = await service(c).createCredential(
        operation(c, c.req.valid("json")),
        c.req.valid("param").id,
        c.req.valid("json").credential,
      );
      c.header(
        "Location",
        `/console/api/providers/${c.req.valid("param").id}/credentials/${result.item.id}`,
      );
      return c.json(result, 201);
    },
  )
  .put(
    "/:id/credentials/order",
    validate("param", resourceIdSchema),
    validate("json", orderSchema),
    async (c) => {
      return c.json(
        await service(c).orderCredentials(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("json").ids,
        ),
      );
    },
  )
  .get(
    "/:id/credentials/:credentialId",
    validate("param", providerCredentialParams),
    async (c) => {
      return c.json(
        await service(c).credential(
          c.req.valid("param").id,
          c.req.valid("param").credentialId,
        ),
      );
    },
  )
  .put(
    "/:id/credentials/:credentialId",
    validate("param", providerCredentialParams),
    validate("json", credentialBody),
    async (c) => {
      return c.json(
        await service(c).updateCredential(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("param").credentialId,
          c.req.valid("json").credential,
        ),
      );
    },
  )
  .delete(
    "/:id/credentials/:credentialId",
    validate("param", providerCredentialParams),
    validate("json", configurationOperationSchema),
    async (c) => {
      return c.json(
        await service(c).removeCredential(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("param").credentialId,
        ),
      );
    },
  )
  .post(
    "/:id/credentials/:credentialId/reveal",
    validate("param", providerCredentialParams),
    validate("json", versionSchema),
    async (c) => {
      return c.json(
        await service(c).revealCredential(
          c.req.valid("param").id,
          c.req.valid("param").credentialId,
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
  )
  .get("/:id/models", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).models(c.req.valid("param").id));
  })
  .put(
    "/:id/models/:modelId/family",
    validate("param", modelParams),
    validate("json", modelBody),
    async (c) =>
      c.json(
        await service(c).saveModelFamily(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("param").modelId,
          c.req.valid("json").settings.context_window,
        ),
      ),
  )
  .get("/:id/models/:modelId", validate("param", modelParams), async (c) => {
    return c.json(
      await service(c).model(
        c.req.valid("param").id,
        c.req.valid("param").modelId,
      ),
    );
  })
  .put(
    "/:id/models/:modelId",
    validate("param", modelParams),
    validate("json", modelBody),
    async (c) => {
      return c.json(
        await service(c).saveModel(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("param").modelId,
          c.req.valid("json").settings.context_window,
        ),
      );
    },
  );
