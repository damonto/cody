import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_REPORTING } from "../../billing/config.ts";
import { reportQuerySchema, type ReportQuery } from "../../reporting/query.ts";
import {
  DAY_MS,
  HOUR_MS,
  previousRange,
  reportRange,
  type ReportRange,
} from "../../reporting/ranges.ts";
import {
  requestDetail,
  requestList,
  summary,
  reportDimensions,
  type ReportFilters,
} from "../../reporting/store.ts";
import { publishedConfig, type AdminContext } from "../context.ts";
import { requestIdSchema } from "../schema.ts";
import { validate } from "../validation.ts";

function filters(query: ReportQuery): ReportFilters {
  const result: ReportFilters = {};
  for (const name of [
    "provider_id",
    "credential_id",
    "client_id",
    "model",
    "currency",
  ] as const) {
    if (query[name]) result[name] = query[name];
  }
  return result;
}
async function rangeFor(query: ReportQuery, env: Env) {
  const config = await publishedConfig(env);
  const now = Date.now();
  const days =
    config?.reporting?.retention_days ?? DEFAULT_REPORTING.retention_days;
  try {
    return {
      config,
      range: reportRange(
        query.period,
        query.time_zone ??
          config?.reporting?.time_zone ??
          DEFAULT_REPORTING.time_zone,
        now,
        query.from !== undefined && query.to !== undefined
          ? { from: query.from, to: query.to }
          : undefined,
      ),
      retention: { days, from: now - days * DAY_MS },
    };
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid report range",
    });
  }
}
function partialHistory(range: ReportRange, retainedFrom: number): boolean {
  return [range.from, range.to].some(
    (time) => time < retainedFrom && time % HOUR_MS !== 0,
  );
}
export const reportRoutes = new Hono<AdminContext>()
  .get(
    "/report-options",
    validate("query", reportQuerySchema),
    async (context) => {
      const query = context.req.valid("query");
      const { config, range } = await rangeFor(query, context.env);
      const history = await reportDimensions(
        context.env.CODY_DB,
        range,
        query.provider_id,
      );
      const sorted = (values: string[]) => [...new Set(values)].sort();
      return context.json({
        time_zone: range.time_zone,
        providers: sorted([
          ...history.providers,
          ...(config?.providers.map((provider) => provider.id) ?? []),
        ]),
        clients: sorted([
          ...history.clients,
          ...(config?.api_keys.map((client) => client.id) ?? []),
        ]),
        models: sorted([
          ...history.models,
          ...(config?.providers
            .filter(
              (provider) =>
                !query.provider_id || provider.id === query.provider_id,
            )
            .flatMap((provider) => provider.models) ?? []),
        ]),
      });
    },
  )
  .get("/summary", validate("query", reportQuerySchema), async (context) => {
    const query = context.req.valid("query");
    const selected = filters(query);
    const { range, retention } = await rangeFor(query, context.env);
    const previous = previousRange(range);
    const partial = partialHistory(range, retention.from);
    return context.json({
      ...(await summary(context.env.CODY_DB, range, selected, {
        group_by: query.group_by,
        sort_by: query.sort_by,
        ...(query.cost_currency ? { cost_currency: query.cost_currency } : {}),
        compare:
          !partial && !!previous && !partialHistory(previous, retention.from),
      })),
      retention,
      partial_history: partial,
    });
  })
  .get("/requests", validate("query", reportQuerySchema), async (context) => {
    const query = context.req.valid("query");
    const { range, retention } = await rangeFor(query, context.env);
    try {
      return context.json({
        ...(await requestList(context.env.CODY_DB, range, filters(query), {
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.outcome ? { outcome: query.outcome } : {}),
          ...(query.quality ? { quality: query.quality } : {}),
        })),
        retention,
      });
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
