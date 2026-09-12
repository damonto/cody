import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { DEFAULT_REPORTING } from "../../billing/config.ts";
import { reportRange } from "../../reporting/ranges.ts";
import {
  requestDetail,
  requestList,
  summary,
  type ReportFilters,
} from "../../reporting/store.ts";
import { publishedConfig, type AdminContext } from "../context.ts";
import { reportQuerySchema, requestIdSchema } from "../schema.ts";
import { validate } from "../validation.ts";
type ReportQuery = z.output<typeof reportQuerySchema>;

function filters(query: ReportQuery): ReportFilters {
  const result: ReportFilters = {};
  for (const name of [
    "service_id",
    "key_id",
    "client_id",
    "model",
    "kind",
    "currency",
  ] as const) {
    if (query[name]) result[name] = query[name];
  }
  return result;
}
async function rangeFor(query: ReportQuery, env: Env) {
  const config = await publishedConfig(env);
  return reportRange(
    query.period,
    query.time_zone ??
      config?.reporting?.time_zone ??
      DEFAULT_REPORTING.time_zone,
  );
}
export const reportRoutes = new Hono<AdminContext>()
  .get("/summary", validate("query", reportQuerySchema), async (context) => {
    const query = context.req.valid("query");
    const selected = filters(query);
    selected.kind ??= "inference";
    return context.json(
      await summary(
        context.env.CODY_DB,
        await rangeFor(query, context.env),
        selected,
      ),
    );
  })
  .get("/requests", validate("query", reportQuerySchema), async (context) => {
    const query = context.req.valid("query");
    try {
      return context.json(
        await requestList(
          context.env.CODY_DB,
          await rangeFor(query, context.env),
          filters(query),
          {
            limit: query.limit,
            ...(query.cursor ? { cursor: query.cursor } : {}),
            ...(query.outcome ? { outcome: query.outcome } : {}),
          },
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid cursor")
        throw new HTTPException(400, { message: "Invalid request cursor" });
      throw error;
    }
  })
  .get("/requests/:id", validate("param", requestIdSchema), async (context) => {
    const item = await requestDetail(
      context.env.CODY_DB,
      context.req.valid("param").id,
    );
    if (!item) throw new HTTPException(404, { message: "Request not found" });
    return context.json(item);
  });
