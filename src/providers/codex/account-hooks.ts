import type { ResolvedCodexOAuth } from "../credentials.ts";
import type {
  PreparedUpstreamRequest,
  ProviderRuntimeContext,
} from "../types.ts";
import {
  accountReply,
  OAuthError,
  proxyConfigurationSchema,
  resolvedOAuthSchema,
  type ProviderConnection,
} from "../oauth/schema.ts";
import { abortable } from "../../shared/abort.ts";
import { logWarn } from "../../shared/log.ts";
import { codexQuotaEvent, codexQuotaHeaders } from "./observations.ts";
import type { CodexQuotaObservation } from "./quota.ts";

/** Hooks are bound to the actual credential snapshot, including the socket's generation. */
export function codexAccountHooks(
  credential: ResolvedCodexOAuth,
  connection: ProviderConnection,
  context: ProviderRuntimeContext,
  headers: Headers,
): Pick<
  PreparedUpstreamRequest,
  "recoverUnauthorized" | "observeResponse" | "observeWebSocketEvent"
> {
  const account = () =>
    context.env.PROVIDER_OAUTH_ACCOUNT.getByName(credential.account_ref);
  const observe = (
    observation: CodexQuotaObservation | undefined,
    receivedAt: number,
  ) => {
    if (!observation) return;
    const operation = Promise.resolve()
      .then(async () => {
        const reply = await account().run({
          action: "codex_usage",
          generation: credential.generation,
          observed_at: receivedAt,
          observation,
        });
        if (!reply.ok && reply.code !== "account_changed")
          throw new Error("Quota observation could not be saved");
      })
      .catch(() => {
        logWarn("oauth.codex.observation_failed", {
          request_id: context.requestId,
        });
      });
    context.context?.waitUntil?.(operation);
  };
  return {
    async recoverUnauthorized(signal) {
      signal.throwIfAborted();
      try {
        const token = await abortable(
          accountReply(
            account().run({
              action: "codex_refresh",
              generation: credential.generation,
              token: credential.token,
              connection,
              proxy_configuration: proxyConfigurationSchema.parse(
                context.config,
              ),
            }),
            resolvedOAuthSchema,
          ),
          signal,
        );
        signal.throwIfAborted();
        if (
          !("account_id" in token) ||
          token.generation !== credential.generation ||
          token.account_id !== credential.account_id
        )
          return;
        context.requestLog?.registerSensitiveValues([token.token]);
        const recoveredHeaders = new Headers(headers);
        recoveredHeaders.set("authorization", `Bearer ${token.token}`);
        recoveredHeaders.delete("x-openai-fedramp");
        if (token.is_fedramp) recoveredHeaders.set("x-openai-fedramp", "true");
        return { headers: recoveredHeaders };
      } catch (error) {
        signal.throwIfAborted();
        logWarn("oauth.codex.recovery_failed", {
          request_id: context.requestId,
          code: error instanceof OAuthError ? error.code : "refresh_failed",
        });
        // Preserve the actual upstream 401 if recovery was unavailable.
        return;
      }
    },
    observeResponse(response) {
      observe(codexQuotaHeaders(response.headers), Date.now());
    },
    observeWebSocketEvent(value, receivedAt) {
      observe(codexQuotaEvent(value), receivedAt);
    },
  };
}
