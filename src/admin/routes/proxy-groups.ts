import { Hono, type Context } from "hono";
import { controlStore, type AdminContext } from "../context.ts";
import { operation } from "../configuration-resource.ts";
import { configurationOperationSchema, versionSchema } from "../schema.ts";
import { validate } from "../validation.ts";
import { ProxyService } from "../../control/services/proxies.ts";
import {
  groupInputSchema,
  nodeInputSchema,
  nodeParams,
  resourceIdSchema,
} from "../resource-schema.ts";
import { testProxy } from "../proxy-test.ts";
const service = (c: Context<AdminContext>) =>
  new ProxyService(controlStore(c.env));
const groupBody = configurationOperationSchema.extend({
  group: groupInputSchema,
});
const nodeBody = configurationOperationSchema.extend({ node: nodeInputSchema });
export const proxyGroupRoutes = new Hono<AdminContext>()
  .get("/", async (c) => {
    return c.json(await service(c).list());
  })
  .post("/", validate("json", groupBody), async (c) => {
    const result = await service(c).save(
      operation(c, c.req.valid("json")),
      c.req.valid("json").group,
    );
    c.header("Location", `/console/api/proxy-groups/${result.item.id}`);
    return c.json(result, 201);
  })
  .get("/:id", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).get(c.req.valid("param").id));
  })
  .put(
    "/:id",
    validate("param", resourceIdSchema),
    validate("json", groupBody),
    async (c) => {
      return c.json(
        await service(c).save(
          operation(c, c.req.valid("json")),
          c.req.valid("json").group,
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
  .get("/:id/nodes", validate("param", resourceIdSchema), async (c) => {
    return c.json(await service(c).nodes(c.req.valid("param").id));
  })
  .post(
    "/:id/nodes",
    validate("param", resourceIdSchema),
    validate("json", nodeBody),
    async (c) => {
      const result = await service(c).saveNode(
        operation(c, c.req.valid("json")),
        c.req.valid("param").id,
        c.req.valid("json").node,
      );
      c.header(
        "Location",
        `/console/api/proxy-groups/${c.req.valid("param").id}/nodes/${result.item.id}`,
      );
      return c.json(result, 201);
    },
  )
  .get("/:id/nodes/:nodeId", validate("param", nodeParams), async (c) => {
    return c.json(
      await service(c).node(
        c.req.valid("param").id,
        c.req.valid("param").nodeId,
      ),
    );
  })
  .put(
    "/:id/nodes/:nodeId",
    validate("param", nodeParams),
    validate("json", nodeBody),
    async (c) => {
      return c.json(
        await service(c).saveNode(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("json").node,
          c.req.valid("param").nodeId,
        ),
      );
    },
  )
  .delete(
    "/:id/nodes/:nodeId",
    validate("param", nodeParams),
    validate("json", configurationOperationSchema),
    async (c) => {
      return c.json(
        await service(c).removeNode(
          operation(c, c.req.valid("json")),
          c.req.valid("param").id,
          c.req.valid("param").nodeId,
        ),
      );
    },
  )
  .post(
    "/:id/nodes/:nodeId/test",
    validate("param", nodeParams),
    validate("json", versionSchema),
    async (c) => {
      return c.json(
        await testProxy(
          await service(c).connection(
            c.req.valid("param").id,
            c.req.valid("param").nodeId,
            c.req.valid("json").version,
          ),
          c.req.raw.signal,
        ),
      );
    },
  );
