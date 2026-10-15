import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus, OAuthAccountStatus } from "../oauth/values.ts";
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
import { devicePending } from "../oauth/state.ts";
import {
  CODEX_DEVICE_TTL_MS,
  CODEX_VERIFICATION_URI,
  CODEX_REDIRECT_URI,
  CODEX_DEVICE_REDIRECT_URI,
  CodexClient,
  authorizationUrl,
  parseIdToken,
} from "./api.ts";
import { initializeCodexAccount } from "./initialization.ts";
import { mergeCodexQuotaObservation } from "./quota.ts";
import { CodexInventory } from "./inventory.ts";

export function codexAccount(
  state: AccountState<typeof ProviderType.Codex>,
  services: AccountServices,
): AccountProvider {
  const client = async (
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) => {
    const [send, signal] = await services.outbound(connection, config);
    return new CodexClient(
      send,
      signal,
      state.current().codex?.is_fedramp ?? false,
    );
  };
  const inventory = new CodexInventory(state, client);
  return {
    recoverUnauthorized: true,
    authorization: {
      browser: {
        redirectUri: CODEX_REDIRECT_URI,
        url: (session) => authorizationUrl(session.state, session.challenge),
        normalizeCallback(redirect) {
          const callback = browserCallback(redirect);
          const suffix = ".onboarding_entrypoint=life_sciences";
          if (callback.state.endsWith(suffix))
            callback.state = callback.state.slice(0, -suffix.length);
          return callback;
        },
        exchange: async (code, session) =>
          (await client(session.connection)).exchange(
            code,
            session.verifier,
            CODEX_REDIRECT_URI,
          ),
      },
      device: {
        ttlMs: CODEX_DEVICE_TTL_MS,
        url: () => CODEX_VERIFICATION_URI,
        async request(session) {
          const generation = state.current().generation;
          const grant = await (await client(session.connection)).startDevice();
          await state.update(generation, (account) => {
            const pending = account.session;
            if (pending?.id !== session.id)
              throw new OAuthError(
                "Authorization session is no longer active",
                410,
              );
            pending.device_auth_id = grant.device_auth_id;
            pending.user_code = grant.user_code;
            pending.poll_interval_ms = grant.interval_ms;
            pending.next_at = Date.now() + grant.interval_ms;
          });
        },
        error: (error) =>
          error instanceof OAuthError && error.status === 404
            ? new OAuthError(
                "Device code sign-in is not enabled for this ChatGPT workspace; use the browser callback instead",
              )
            : error,
        async poll() {
          const snapshot = state.current();
          const session = snapshot.session;
          if (!session || !devicePending(session)) return;
          if (!session.device_auth_id || !session.user_code) return;
          const issuer = await client(session.connection);
          const approved = await issuer.pollDevice({
            device_auth_id: session.device_auth_id,
            user_code: session.user_code,
          });
          if (!approved) {
            await state.update(snapshot.generation, (account) => {
              const pending = account.session;
              if (pending?.id === session.id && devicePending(pending))
                pending.next_at = Date.now() + pending.poll_interval_ms;
            });
            return;
          }
          await state.update(snapshot.generation, (account) => {
            const pending = account.session;
            if (pending?.id !== session.id || !devicePending(pending))
              throw new OAuthError("Authorization is no longer pending", 409);
            pending.status = OAuthSessionStatus.Exchanging;
            pending.user_code = null;
          });
          const tokens = await issuer.exchange(
            approved.code,
            approved.verifier,
            CODEX_DEVICE_REDIRECT_URI,
          );
          await state.update(snapshot.generation, (account) => {
            const pending = account.session;
            if (
              pending?.id !== session.id ||
              pending.status !== OAuthSessionStatus.Exchanging
            )
              throw new OAuthError(
                "Authorization session is no longer active",
                410,
              );
            pending.tokens = tokens;
            pending.device_auth_id = null;
            pending.status = OAuthSessionStatus.Initializing;
            pending.next_at = Date.now();
          });
        },
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
        if (!tokens.id_token)
          throw new OAuthError(
            "ChatGPT did not return an identity token; start authorization again",
            502,
          );
        const claims = parseIdToken(tokens.id_token);
        const identity = {
          id: `${claims.account_id}:${claims.user_id ?? claims.email ?? claims.account_id}`,
          email: claims.email,
        };
        if (snapshot.identity && snapshot.identity.id !== identity.id)
          throw new OAuthError(
            "This is a different ChatGPT account; add it as a new account instead",
          );
        await state.update(snapshot.generation, (account) => {
          initializeCodexAccount(account, session, claims, identity);
        });
      },
    },
    credential() {
      const account = state.current();
      if (!account.codex || !account.tokens) return unavailableIdentity();
      return {
        token: account.tokens.access_token,
        account_id: account.codex.account_id,
        generation: account.generation,
        ...(account.codex.is_fedramp ? { is_fedramp: true } : {}),
      };
    },
    async refresh(generation, tokens, connection, config) {
      const result = await (
        await client(connection, config)
      ).refresh(tokens.refresh_token, tokens);
      const claims = result.id_token ? parseIdToken(result.id_token) : null;
      if (claims && claims.account_id !== state.current().codex?.account_id)
        throw new OAuthError(
          "Token refresh returned a different workspace; reconnect this account",
          401,
          "invalid_grant",
        );
      await state.update(generation, (account) => {
        account.tokens = {
          ...result,
          refresh_token: result.refresh_token ?? tokens.refresh_token,
        };
        if (
          claims &&
          account.codex &&
          claims.account_id === account.codex.account_id
        )
          account.codex = {
            ...account.codex,
            is_fedramp: claims.is_fedramp ?? false,
            plan_type: claims.plan_type ?? account.codex.plan_type,
            subscription_active_until:
              claims.subscription_active_until ??
              account.codex.subscription_active_until,
          };
        account.error = null;
      });
    },
    inventory,
    resets: {
      refresh: () => inventory.refreshResetCredits(),
      consume: (redeemRequestId, creditId) =>
        inventory.consumeReset(redeemRequestId, creditId),
    },
    async observe(command) {
      if (command.action !== "codex_usage")
        throw new OAuthError("Unsupported account observation", 400);
      await state.update(command.generation, (account) => {
        if (
          account.provider_type !== ProviderType.Codex ||
          account.status !== OAuthAccountStatus.Ready
        )
          return;
        Object.assign(
          account,
          mergeCodexQuotaObservation(
            account,
            command.observation,
            Math.min(Date.now(), command.observed_at),
          ),
        );
      });
    },
  };
}
