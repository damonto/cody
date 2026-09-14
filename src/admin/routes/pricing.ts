import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { calculateCost } from "../../billing/calculate.ts";
import { modelPolicySchema } from "../../billing/schema.ts";
import {
  previewSchema,
  priceHistoryQuerySchema,
  priceVersionQuerySchema,
} from "../schema.ts";
import { validate } from "../validation.ts";
import type { AdminContext } from "../context.ts";

interface PriceRow {
  id: string;
  revision: number;
  policy_json: string;
  created_at: number;
}
function priceView({ policy_json, ...row }: PriceRow) {
  return { ...row, policy: modelPolicySchema.parse(JSON.parse(policy_json)) };
}
export const pricingRoutes = new Hono<AdminContext>()
  .get("/history", validate("query", priceHistoryQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const result = await c.env.CODY_DB.prepare(
      "SELECT id, revision, policy_json, created_at FROM pricing_versions WHERE provider_id = ? AND model = ? ORDER BY revision DESC LIMIT 100",
    )
      .bind(query.provider_id, query.model)
      .all<PriceRow>();
    return c.json({ items: result.results.map(priceView) });
  })
  .get("/version", validate("query", priceVersionQuerySchema), async (c) => {
    const row = await c.env.CODY_DB.prepare(
      "SELECT id, revision, policy_json, created_at FROM pricing_versions WHERE id = ?",
    )
      .bind(c.req.valid("query").id)
      .first<PriceRow>();
    if (!row)
      throw new HTTPException(404, { message: "Price version not found" });
    return c.json(priceView(row));
  })
  .post("/preview", validate("json", previewSchema), (c) => {
    const input = c.req.valid("json");
    try {
      return c.json(calculateCost(input.usage, input.policy));
    } catch {
      throw new HTTPException(400, {
        message: "The calculated cost exceeds supported monetary precision",
      });
    }
  });
