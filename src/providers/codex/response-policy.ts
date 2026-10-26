import type { CodexProviderConfig } from "../../config/types.ts";
import {
  recordCredentialQuotaCooldown,
  scheduleHealthUpdate,
} from "../../gateway/health/health.ts";
import type {
  PreparedUpstreamRequest,
  ProviderRuntimeContext,
} from "../types.ts";
import { inspectCodexResponse } from "./inspect.ts";
import type { CodexUsageLimit } from "./limits.ts";

export function codexResponsePolicy(
  provider: CodexProviderConfig,
  credentialId: string,
  context: ProviderRuntimeContext,
  detectFormat: boolean,
  mode: "native" | "siwc" = "native",
): Pick<PreparedUpstreamRequest, "responseInspector"> {
  const persist = async (limit: CodexUsageLimit) => {
    const health = context.env.HEALTH;
    return health
      ? recordCredentialQuotaCooldown(
          { HEALTH: health },
          provider.id,
          credentialId,
          limit.resets_at,
          context.requestId,
        )
      : false;
  };
  return {
    responseInspector: {
      phase: "retry",
      async inspect(response, signal, timeoutMs) {
        const {
          response: inspected,
          usageLimit,
          ...retry
        } = await inspectCodexResponse(response, {
          signal,
          timeoutMs,
          mode,
          detectFormat,
          errorCodes: provider.retry?.error_codes,
          onStreamLimit: (limit) =>
            scheduleHealthUpdate(context.context, persist(limit)),
        });
        return {
          response: inspected,
          retry,
          ...(usageLimit
            ? {
                accountSwitch: {
                  limit: usageLimit,
                  async persist() {
                    if (await persist(usageLimit)) return "recorded" as const;
                    context.requestLog?.warn({
                      outcome: "codex_quota_write_failed",
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
