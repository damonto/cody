import { ProviderType } from "../../config/values.ts";
import { OAuthAccountStatus, OAuthFlow } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type {
  AccountProvider,
  AccountState,
  AccountServices,
} from "../oauth/provider.ts";
import { siwcState } from "./partition.ts";
import { SiwcClient } from "./siwc.ts";
import type { CodexMode } from "./account-schema.ts";
import { terminalSessionStatuses } from "../oauth/state.ts";
import { nativeCodexAccount } from "./native-account.ts";
import { siwcAccount } from "./siwc-account.ts";
import { mergeCodexQuotaObservation } from "./quota.ts";

/** Authorization chooses the pending protocol; credential operations use the committed mode. */
export function codexAccount(
  state: AccountState<typeof ProviderType.Codex>,
  services: AccountServices,
  mode: CodexMode = "native",
): AccountProvider {
  const partition = siwcState(state);
  const siwc = siwcAccount(partition, services);
  if (mode === "siwc")
    return {
      ...siwc,
      async disconnect() {
        const generation = partition.current().generation;
        await siwc.disconnect();
        await state.update(
          generation + 1,
          (account) => {
            account.siwc_revocation_error = account.siwc?.error ?? null;
            account.siwc = null;
          },
          "siwc",
        );
      },
    };
  const native = nativeCodexAccount(state, services);
  return {
    ...native,
    authorization: {
      ...native.authorization,
      ...siwc.authorization,
      validateStart(account, flow) {
        if (
          account.session &&
          !terminalSessionStatuses.has(account.session.status) &&
          account.session.status !== "error"
        )
          throw new OAuthError(
            "An authorization is already pending; cancel it first",
            409,
          );
        if (
          flow === OAuthFlow.Siwc &&
          (!account.codex ||
            !account.tokens ||
            account.status !== OAuthAccountStatus.Ready)
        )
          throw new OAuthError(
            "SIWC binding requires an existing authorized native Codex account",
            400,
          );
      },
      initialize: () =>
        (state.current().session?.flow === OAuthFlow.Siwc
          ? siwc
          : native
        ).authorization.initialize(),
    },
    async disconnect() {
      const snapshot = state.current();
      const registration = snapshot.siwc?.codex?.siwc;
      const refreshToken = snapshot.siwc?.tokens?.refresh_token;
      await state.update(snapshot.generation, (account) => {
        account.generation++;
        account.authorization_generation++;
        account.siwc_generation++;
        account.tokens = null;
        account.siwc = null;
        account.session = null;
        account.status = OAuthAccountStatus.Disconnected;
        account.error = null;
      });
      if (registration && refreshToken) {
        try {
          const [send, signal] = await services.outbound();
          await new SiwcClient(send, signal).revoke(
            refreshToken,
            registration.client_id,
          );
        } catch {
          await state.update(snapshot.generation + 1, (account) => {
            account.error =
              "Local tokens cleared; remote revocation was not confirmed. Disconnect Cody in ChatGPT Settings.";
          });
        }
      }
    },
    async observe(command) {
      if (command.action !== "codex_usage")
        throw new OAuthError("Unsupported account observation", 400);
      const observations = command.mode === "siwc" ? partition : state;
      await observations.update(command.generation, (account) => {
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
