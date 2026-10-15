import { scheduleHealthUpdate } from "../../gateway/health/health.ts";
import { discardBody } from "../../gateway/http/body.ts";
import type { ApiProtocol } from "../../gateway/protocol-values.ts";
import type { ResolvedXaiOAuth } from "../credentials.ts";
import { accountReply, accountViewSchema } from "../oauth/schema.ts";
import type {
  AccountLimit,
  PreparedUpstreamRequest,
  ProviderRuntimeContext,
} from "../types.ts";
import { recordXaiLimit, xaiQuotaResponse } from "./availability.ts";
import { inspectXaiResponse } from "./inspect.ts";

export function xaiResponsePolicy(
  credential: ResolvedXaiOAuth,
  model: string,
  protocol: ApiProtocol,
  context: ProviderRuntimeContext,
  transformResponse: NonNullable<PreparedUpstreamRequest["transformResponse"]>,
): Pick<PreparedUpstreamRequest, "responseInspector"> {
  const persist = (limit: AccountLimit) =>
    recordXaiLimit(
      context.env,
      credential.account_ref,
      credential.generation,
      limit,
    );
  const invalidate = async () => {
    await accountReply(
      context.env.PROVIDER_OAUTH_ACCOUNT.getByName(credential.account_ref).run({
        action: "xai_auth_invalid",
        generation: credential.generation,
        token: credential.token,
      }),
      accountViewSchema,
    );
  };
  return {
    responseInspector: {
      phase: "transport",
      async inspect(response, signal) {
        if (response.status === 401) await invalidate();
        const inspected = await inspectXaiResponse(
          response,
          model,
          (limit) => scheduleHealthUpdate(context.context, persist(limit)),
          signal,
          invalidate,
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
                    if (!response.ok) return transformResponse(response);
                    await discardBody(response.body);
                    return xaiQuotaResponse(
                      protocol,
                      limit.resets_at,
                      context.requestId,
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
