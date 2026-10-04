import { readEntities } from "../../control/repository.ts";
import { antigravityVariant } from "../../shared/antigravity-models.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { calculateCost } from "../../billing/calculate.ts";
import { modelPriceSchema } from "../../billing/schema.ts";
import type { AdminContext } from "../context.ts";
import {
  previewSchema,
  priceHistoryQuerySchema,
  priceVersionQuerySchema,
} from "../schema.ts";
import { validate } from "../validation.ts";

interface PriceRow {
  id: string;
  revision: number;
  price_json: string;
  created_at: number;
}
function priceView({ price_json, ...row }: PriceRow) {
  return { ...row, price: modelPriceSchema.parse(JSON.parse(price_json)) };
}
export const pricingRoutes = new Hono<AdminContext>()
  .get("/history", validate("query", priceHistoryQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const rows = await readEntities(c.env.CODY_DB, [
      "providers",
      "provider_models",
    ]);
    const provider = rows.providers.find((row) => row.id === query.provider_id);
    const variants =
      provider?.type === "antigravity"
        ? rows.provider_models
            .filter(
              (row) =>
                row.provider_id === provider.id &&
                antigravityVariant(row.model)?.family === query.model,
            )
            .map((row) => row.model)
        : [];
    const models = [...new Set(variants.length ? variants : [query.model])];
    const result = await c.env.CODY_DB.prepare(
      `SELECT v.id, v.revision, v.price_json, v.created_at FROM model_price_versions v JOIN model_prices p ON p.id = v.model_price_id JOIN provider_models m ON m.id = p.provider_model_id WHERE m.provider_id = ? AND m.model IN (${models.map(() => "?").join(",")}) ORDER BY v.revision DESC, v.created_at DESC, v.id LIMIT ?`,
    )
      .bind(query.provider_id, ...models, models.length * 100)
      .all<PriceRow>();
    const versions = new Map<string, ReturnType<typeof priceView>>();
    for (const row of result.results) {
      const item = priceView(row);
      const key = `${item.revision}:${JSON.stringify(item.price.pricing)}`;
      if (!versions.has(key))
        versions.set(key, {
          ...item,
          price: { ...item.price, model: query.model },
        });
    }
    return c.json({ items: [...versions.values()].slice(0, 100) });
  })
  .get("/version", validate("query", priceVersionQuerySchema), async (c) => {
    const row = await c.env.CODY_DB.prepare(
      "SELECT id, revision, price_json, created_at FROM model_price_versions WHERE id = ?",
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
      return c.json(calculateCost(input.usage, input.price));
    } catch {
      throw new HTTPException(400, {
        message: "The calculated cost exceeds supported monetary precision",
      });
    }
  });
