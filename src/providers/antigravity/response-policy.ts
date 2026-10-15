import { scheduleHealthUpdate } from "../../gateway/health/health.ts";
import { discardBody } from "../../gateway/http/body.ts";
import type { ApiProtocol } from "../../gateway/protocol-values.ts";
import type {
  PreparedUpstreamRequest,
  AccountLimit,
  ProviderRuntimeContext,
} from "../types.ts";
import { recordAntigravityLimit } from "./availability.ts";
import { antigravityQuotaResponse } from "./exhaustion.ts";
import { inspectAntigravityResponse } from "./inspect.ts";

export function antigravityResponsePolicy(
  accountRef: string,
  model: string,
  protocol: ApiProtocol,
  context: ProviderRuntimeContext,
): Pick<PreparedUpstreamRequest, "responseInspector"> {
  const persist = async (limit: AccountLimit) => {
    const health = context.env.HEALTH;
    if (!health) throw new Error("Account quota storage is unavailable");
    await recordAntigravityLimit({ HEALTH: health }, accountRef, model, limit);
  };
  return {
    responseInspector: {
      phase: "transport",
      async inspect(response, signal) {
        const inspected = await inspectAntigravityResponse(
          response,
          (limit) => scheduleHealthUpdate(context.context, persist(limit)),
          signal,
        );
        const limit = inspected.accountLimit;
        return {
          response: inspected.response,
          ...(limit
            ? {
                accountSwitch: {
                  limit,
                  async persist() {
                    try {
                      await persist(limit);
                      return "recorded" as const;
                    } catch {
                      return "unavailable" as const;
                    }
                  },
                  async exhausted(response: Response) {
                    await discardBody(response.body);
                    return antigravityQuotaResponse(
                      protocol,
                      limit.resets_at,
                      context.requestId ?? "unknown",
                    );
                  },
                },
              }
            : {}),
        };
      },
    },
  };
}
