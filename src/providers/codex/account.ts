import { ProviderType } from "../../config/values.ts";
import { OAuthAccountStatus, OAuthFlow } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type {
  AccountProvider,
  AccountState,
  AccountServices,
} from "../oauth/provider.ts";
import { nativeCodexAccount } from "./native-account.ts";
import { siwcAccount } from "./siwc-account.ts";
import { mergeCodexQuotaObservation } from "./quota.ts";

/** Authorization chooses the pending protocol; credential operations use the committed mode. */
export function codexAccount(
  state: AccountState<typeof ProviderType.Codex>,
  services: AccountServices,
): AccountProvider {
  const native = nativeCodexAccount(state, services);
  const siwc = siwcAccount(state, services);
  const active = () => (state.current().codex?.mode === "siwc" ? siwc : native);
  return {
    recoverUnauthorized: true,
    authorization: {
      ...native.authorization,
      ...siwc.authorization,
      validateStart(account, flow) {
        if (
          account.codex &&
          (account.codex.mode === "siwc") !== (flow === OAuthFlow.Siwc)
        )
          throw new OAuthError(
            "Add a new account to use another Codex sign-in mode",
            409,
          );
      },
      initialize: () =>
        (state.current().session?.flow === OAuthFlow.Siwc
          ? siwc
          : native
        ).authorization.initialize(),
    },
    refresh: (...args) => active().refresh(...args),
    inventory: {
      models: () => active().inventory.models(),
      quota: (generation) => active().inventory.quota(generation),
    },
    get resets() {
      return active().resets;
    },
    get disconnect() {
      return active().disconnect;
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
