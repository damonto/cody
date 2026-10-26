import { codexQuotaSyncSchema } from "./quota.ts";
import { hasSiwcPlanUsage } from "./account-schema.ts";
import { abortableDelay } from "../../shared/abort.ts";
import { z } from "zod";
import { ProviderType } from "../../config/values.ts";
import { OAuthAccountStatus, OAuthSessionStatus } from "../oauth/values.ts";
import {
  OAuthError,
  type ProviderConnection,
  type ProxyConfiguration,
} from "../oauth/schema.ts";
import { completeAuthorization } from "../oauth/initialization.ts";
import type {
  AccountProvider,
  AccountServices,
  AccountState,
} from "../oauth/provider.ts";
import { browserCallback } from "../oauth/provider.ts";
import { base64url } from "../oauth/state.ts";
import { CODEX_ISSUER, parseModels } from "./api.ts";
import { SiwcClient, SIWC_REDIRECT_URI, siwcAuthorizationUrl } from "./siwc.ts";

export function siwcAccount(
  state: AccountState<typeof ProviderType.Codex>,
  services: AccountServices,
): AccountProvider {
  const client = async (
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) => {
    const [send, signal] = await services.outbound(connection, config);
    return new SiwcClient(send, signal);
  };
  return {
    recoverUnauthorized: true,
    authorization: {
      siwc: {
        redirectUri: SIWC_REDIRECT_URI,
        normalizeCallback: browserCallback,
        url: siwcAuthorizationUrl,
        async prepare(session, consent, previous) {
          const snapshot = state.current();
          const hostId = await services.hostId();
          await state.updateAuthorization(
            snapshot.authorization_generation,
            (account) => {
              if (account.session?.id !== session.id)
                throw new OAuthError("Authorization changed", 409);
              account.session.siwc = {
                authorization_generation: snapshot.authorization_generation,
                nonce: base64url(crypto.getRandomValues(new Uint8Array(32))),
                host_id: hostId,
                client_id:
                  account.codex?.siwc?.client_id ??
                  previous?.siwc?.client_id ??
                  null,
                consent,
              };
            },
          );
        },
        async exchange(code, session, callback) {
          const pending = session.siwc;
          if (!pending)
            throw new OAuthError("SIWC session is unavailable", 409);
          const ids = callback.searchParams.getAll("client_id");
          const clientId = ids[0] ?? pending.client_id;
          if (
            ids.length > 1 ||
            !clientId ||
            clientId !== clientId.trim() ||
            clientId === "dynamic_agent_client" ||
            (pending.client_id && clientId !== pending.client_id)
          )
            throw new OAuthError("Invalid issued SIWC client ID");
          const generation = pending.authorization_generation;
          // Retain the issued registration when a code must be replaced.
          await state.updateAuthorization(generation, (account) => {
            if (account.session?.id !== session.id || !account.session.siwc)
              throw new OAuthError("Authorization changed", 409);
            account.session.siwc.client_id = clientId;
          });
          const result = await (
            await client(session.connection)
          ).exchange(code, clientId, session);
          await state.updateAuthorization(generation, (account) => {
            if (account.session?.id !== session.id || !account.session.siwc)
              throw new OAuthError("Authorization changed", 409);
            account.session.siwc.registration = {
              issuer: CODEX_ISSUER,
              subject: result.identity.subject,
              client_id: clientId,
              scopes: result.scopes,
            };
            account.session.siwc.email = result.identity.email;
          });
          return result.tokens;
        },
      },
      async initialize() {
        const snapshot = state.current();
        const session = snapshot.session;
        const registration = session?.siwc?.registration;
        const tokens = session?.tokens;
        if (
          !tokens ||
          !session ||
          !registration ||
          session.status !== OAuthSessionStatus.Initializing
        )
          return;
        const identityId = JSON.stringify([
          registration.issuer,
          registration.subject,
          registration.client_id,
        ]);
        if (snapshot.identity && snapshot.identity.id !== identityId)
          throw new OAuthError(
            "This is a different ChatGPT registration; add a new account instead",
          );
        const enabled = hasSiwcPlanUsage(registration.scopes);
        await state.replaceCredentials(
          snapshot.authorization_generation,
          !tokens.refresh_token && !!snapshot.tokens?.refresh_token,
          (account) => {
            const pending = account.session;
            if (
              pending?.id !== session.id ||
              pending.status !== OAuthSessionStatus.Initializing ||
              Date.now() >= pending.expires_at
            )
              throw new OAuthError("Authorization expired or changed", 410);
            account.tokens = {
              ...tokens,
              refresh_token:
                tokens.refresh_token ?? account.tokens?.refresh_token,
            };
            account.identity = {
              id: identityId,
              email: session.siwc?.email ?? null,
            };
            account.codex = {
              mode: "siwc",
              siwc: registration,
              plan_usage_enabled: enabled,
              account_id: null,
              user_id: null,
              plan_type: null,
              subscription_active_until: null,
            };
            completeAuthorization(account, pending);
            account.codex_quota_sync = codexQuotaSyncSchema.parse({});
            delete pending.siwc;
            account.models = [];
            account.models_updated_at = null;
          },
        );
      },
    },
    async refresh(generation, tokens, connection, config) {
      const registration = state.current().codex?.siwc;
      if (!registration)
        throw new OAuthError("SIWC registration is unavailable", 503);
      try {
        const result = await (
          await client(connection, config)
        ).refresh(
          tokens.refresh_token,
          registration.client_id,
          registration.subject,
        );
        await state.update(generation, (account) => {
          account.tokens = {
            ...result.tokens,
            id_token: result.tokens.id_token ?? tokens.id_token,
          };
          if (account.codex?.siwc && result.scopes) {
            account.codex.siwc.scopes = result.scopes;
            account.codex.plan_usage_enabled = hasSiwcPlanUsage(result.scopes);
          }
          account.error = null;
        });
      } catch (error) {
        if (error instanceof OAuthError && error.code === "invalid_grant")
          await state.update(generation, (account) => {
            account.tokens = null;
            account.status = OAuthAccountStatus.NeedsReauthorization;
          });
        throw error;
      }
    },
    inventory: {
      async models() {
        let token = await state.resolve();
        if (!("siwc_subject" in token))
          throw new OAuthError("SIWC registration changed", 409);
        const issuer = await client();
        let value: unknown;
        try {
          value = await issuer.models(token.token);
        } catch (error) {
          if (!(error instanceof OAuthError) || error.status !== 401)
            throw error;
          token = await state.resolve({
            generation: token.generation,
            token: token.token,
          });
          value = await issuer.models(token.token);
        }
        const catalog = z
          .object({ models: z.array(z.record(z.string(), z.unknown())) })
          .parse(value);
        return parseModels({
          models: catalog.models.filter((model) => model.visibility === "list"),
        });
      },
      async quota() {
        /* SIWC exposes passive observations, not a private quota endpoint. */
      },
    },
    async disconnect() {
      const snapshot = state.current();
      const registration = snapshot.codex?.siwc;
      const refreshToken = snapshot.tokens?.refresh_token;
      await state.update(snapshot.generation, (account) => {
        account.generation++;
        account.authorization_generation++;
        account.status = OAuthAccountStatus.Disconnected;
        account.session = null;
      });
      const generation = snapshot.generation + 1;
      let confirmed = !refreshToken;
      if (refreshToken && registration) {
        for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
          try {
            await (await client()).revoke(refreshToken, registration.client_id);
            confirmed = true;
          } catch (error) {
            if (error instanceof OAuthError && error.status < 500) break;
            if (attempt === 0)
              await abortableDelay(250, new AbortController().signal);
          }
        }
      }
      await state.update(generation, (account) => {
        account.tokens = null;
        account.error = confirmed
          ? null
          : "Local tokens cleared; remote revocation was not confirmed. Disconnect Cody in ChatGPT Settings.";
      });
    },
  };
}
