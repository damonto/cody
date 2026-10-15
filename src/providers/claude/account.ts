import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus } from "../oauth/values.ts";
import {
  OAuthError,
  type ProviderConnection,
  type ProxyConfiguration,
} from "../oauth/schema.ts";
import type {
  AccountProvider,
  AccountState,
  AccountServices,
} from "../oauth/provider.ts";
import { browserCallback, unavailableIdentity } from "../oauth/provider.ts";
import {
  ClaudeClient,
  CLAUDE_REDIRECT_URI,
  authorizationUrl,
  parseProfile as parseClaudeProfile,
} from "./api.ts";
import { initializeClaudeAccount } from "./initialization.ts";
import { ClaudeInventory } from "./inventory.ts";

export function claudeAccount(
  state: AccountState<typeof ProviderType.Claude>,
  services: AccountServices,
): AccountProvider {
  const client = async (
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) => new ClaudeClient(...(await services.outbound(connection, config)));
  return {
    authorization: {
      browser: {
        redirectUri: CLAUDE_REDIRECT_URI,
        url: (session) => authorizationUrl(session.state, session.challenge),
        normalizeCallback(redirect) {
          if (!URL.canParse(redirect)) {
            const [code, state, extra] = redirect.trim().split("#");
            if (!code || !state || extra)
              throw new OAuthError(
                "Paste the Claude authorization code including its state",
              );
            redirect = `${CLAUDE_REDIRECT_URI}?${new URLSearchParams({ code, state }).toString()}`;
          }
          return browserCallback(redirect);
        },
        exchange: async (code, session) =>
          (await client(session.connection)).exchange(
            code,
            session.verifier,
            session.state,
          ),
      },
      async initialize() {
        const snapshot = state.current();
        const session = snapshot.session;
        if (
          !session?.tokens ||
          session.status !== OAuthSessionStatus.Initializing
        )
          return;
        const tokens = session.tokens;
        const profile = parseClaudeProfile(
          await (await client(session.connection)).profile(tokens.access_token),
        );
        if (snapshot.identity && snapshot.identity.id !== profile.identity.id)
          throw new OAuthError(
            "This is a different Claude account or organization; add it as a new account",
          );
        await state.update(snapshot.generation, (account) => {
          initializeClaudeAccount(account, session, profile);
        });
      },
    },
    credential() {
      const account = state.current();
      if (!account.claude || !account.tokens) return unavailableIdentity();
      return {
        token: account.tokens.access_token,
        claude_organization_id: account.claude.organization_id,
        generation: account.generation,
      };
    },
    async refresh(generation, tokens, connection, config) {
      const snapshot = state.current();
      // Preserve rotated tokens without a fallible profile lookup after the grant.
      const result = await (
        await client(connection, config)
      ).refresh(tokens.refresh_token, snapshot.claude ?? undefined);
      await state.update(generation, (account) => {
        account.tokens = {
          ...result,
          refresh_token: result.refresh_token ?? tokens.refresh_token,
        };
        account.error = null;
      });
    },
    inventory: new ClaudeInventory(state, client),
    async observe(command) {
      if (
        command.action !== "claude_limit" &&
        command.action !== "claude_usage"
      )
        throw new OAuthError("Unsupported account observation", 400);
      await state.update(command.generation, (account) => {
        account.claude_quota_revision++;
        const observations =
          command.action === "claude_limit"
            ? [command, ...(command.additional_limits ?? [])]
            : (command.limits ?? []);
        if (observations.length) {
          const limits = (account.quota.claude_limits ?? []).filter(
            (limit) => limit.until > Date.now(),
          );
          for (const observation of observations) {
            const existing = limits.find(
              (limit) => limit.model === observation.model,
            );
            if (existing)
              existing.until = Math.max(existing.until, observation.until);
            else
              limits.push({
                model: observation.model,
                until: observation.until,
              });
          }
          account.quota.claude_limits = limits;
        }
        if (command.action === "claude_limit") return;
        if (
          command.extra_usage_disabled_reason !== undefined &&
          account.quota.extra_usage
        )
          account.quota.extra_usage.disabled_reason =
            command.extra_usage_disabled_reason;
        for (const group of command.groups) {
          const index = account.quota.groups.findIndex(
            (previous) => previous.id === group.id,
          );
          if (index === -1) account.quota.groups.push(group);
          else {
            const previous = account.quota.groups[index];
            const previousReset = Date.parse(
              previous.buckets[0]?.reset_at ?? "",
            );
            const nextReset = Date.parse(group.buckets[0]?.reset_at ?? "");
            if (
              !Number.isFinite(previousReset) ||
              nextReset > previousReset ||
              (nextReset === previousReset &&
                (group.buckets[0]?.used_percent ?? 0) >=
                  (previous.buckets[0]?.used_percent ?? 0))
            )
              account.quota.groups[index] = group;
          }
        }
      });
    },
  };
}
