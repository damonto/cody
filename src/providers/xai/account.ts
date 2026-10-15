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
import { unavailableIdentity } from "../oauth/provider.ts";
import { devicePending } from "../oauth/state.ts";
import { XaiClient, xaiIdentity } from "./api.ts";
import { xaiModels } from "./models.ts";
import { initializeXaiAccount } from "./initialization.ts";
import { xaiCredentialSchema } from "./account-schema.ts";
import { equalSecret } from "../../shared/equal-secret.ts";

export function xaiAccount(
  state: AccountState<typeof ProviderType.Xai>,
  services: AccountServices,
): AccountProvider {
  const client = async (
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) => new XaiClient(...(await services.outbound(connection, config)));
  return {
    authorization: {
      device: {
        ttlMs: 15 * 60_000,
        url: (session) =>
          session.xai_device?.verification_uri_complete ??
          session.xai_device?.verification_uri ??
          null,
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
            pending.xai_device = grant;
            pending.user_code = grant.user_code;
            pending.expires_at =
              Date.now() + Math.min(grant.expires_in, 1800) * 1000;
            pending.poll_interval_ms = Math.max(5, grant.interval) * 1000;
            pending.next_at = Date.now() + pending.poll_interval_ms;
          });
        },
        async poll() {
          const snapshot = state.current();
          const session = snapshot.session;
          if (!session || !devicePending(session)) return;
          if (!session.xai_device) return;
          const result = await (
            await client(session.connection)
          ).pollDevice(session.xai_device);
          await state.update(snapshot.generation, (account) => {
            const pending = account.session;
            if (
              !pending ||
              pending.id !== session.id ||
              !devicePending(pending) ||
              Date.now() >= pending.expires_at
            )
              throw new OAuthError(
                "Authorization session is no longer active",
                410,
              );
            if (result.tokens) {
              pending.tokens = result.tokens;
              pending.status = OAuthSessionStatus.Initializing;
              pending.xai_device = undefined;
              pending.user_code = null;
              pending.next_at = Date.now();
            } else {
              if (result.slow) pending.poll_interval_ms += 5000;
              pending.next_at = Date.now() + pending.poll_interval_ms;
            }
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
        const claims = xaiIdentity(tokens);
        if (snapshot.identity && snapshot.identity.id !== claims.sub)
          throw new OAuthError(
            "This is a different xAI account; add a new account",
            400,
          );
        await state.update(snapshot.generation, (account) => {
          initializeXaiAccount(account, session, claims, tokens);
        });
      },
    },
    credential() {
      const account = state.current();
      if (!account.xai || !account.tokens) return unavailableIdentity();
      return {
        token: account.tokens.access_token,
        xai_subject: account.xai.subject,
        generation: account.generation,
      };
    },
    async refresh(generation, tokens, connection, config) {
      const snapshot = state.current();
      if (!snapshot.xai) return unavailableIdentity();
      const result = await (
        await client(connection, config)
      ).refresh(tokens, snapshot.xai.subject);
      await state.update(generation, (account) => {
        account.tokens = {
          ...result,
          refresh_token: result.refresh_token ?? tokens.refresh_token,
        };
        account.error = null;
      });
    },
    inventory: {
      models: async () => xaiModels(),
      async quota(generation) {
        const token = xaiCredentialSchema.parse(await state.resolve());
        const usage = await (
          await client()
        ).quota(token.token, token.xai_subject);
        await state.update(generation, (account) => {
          account.quota = { ...usage, xai_limits: account.quota.xai_limits };
        });
      },
    },
    async observe(command) {
      if (command.action === "xai_auth_invalid") {
        await state.update(command.generation, async (account) => {
          if (
            !account.tokens ||
            !(await equalSecret(account.tokens.access_token, command.token))
          )
            return;
          account.status = OAuthAccountStatus.NeedsReauthorization;
          account.error = "Reconnect this xAI account";
        });

        return;
      }
      if (command.action !== "xai_limit")
        throw new OAuthError("Unsupported account observation", 400);
      await state.update(command.generation, (account) => {
        const limits = (account.quota.xai_limits ?? []).filter(
          (limit) => limit.until > Date.now(),
        );
        const previous = limits.find(
          (limit) =>
            limit.model === command.model && limit.kind === command.kind,
        );
        if (previous) previous.until = Math.max(previous.until, command.until);
        else
          limits.push({
            model: command.model,
            until: command.until,
            kind: command.kind,
          });
        account.quota.xai_limits = limits;
      });
    },
  };
}
