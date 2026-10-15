import type { ResolvedClaudeOAuth } from "../credentials.ts";
import type {
  PreparedUpstreamRequest,
  ProviderRuntimeContext,
} from "../types.ts";
import { claudeUsageLimit, responseQuotaObservation } from "./limits.ts";

export function claudeResponsePolicy(
  credential: ResolvedClaudeOAuth,
  model: string,
  context: ProviderRuntimeContext,
): Pick<PreparedUpstreamRequest, "responseInspector" | "observeFinalResponse"> {
  const account = () =>
    context.env.PROVIDER_OAUTH_ACCOUNT.getByName(credential.account_ref);
  return {
    async observeFinalResponse(response) {
      const observation = responseQuotaObservation(response.headers, model);
      if (observation)
        await account()
          .run({
            action: "claude_usage",
            ...observation,
            generation: credential.generation,
          })
          .catch(() => undefined);
    },
    responseInspector: {
      phase: "retry",
      async inspect(response) {
        const limit = claudeUsageLimit(response, model);
        return {
          response,
          ...(limit
            ? {
                accountSwitch: {
                  limit: {
                    code: "usage_limit_reached",
                    resets_at: limit.until,
                  },
                  async persist() {
                    const saved = await account()
                      .run({
                        action: "claude_limit",
                        generation: credential.generation,
                        ...limit,
                      })
                      .catch(() => undefined);
                    if (saved?.ok) return "recorded" as const;
                    context.requestLog?.warn({
                      outcome: "claude_quota_write_failed",
                    });
                    return "unrecorded" as const;
                  },
                  exhausted: (response: Response) => response,
                },
              }
            : {}),
        };
      },
    },
  };
}
