import { ProviderType } from "../../config/values.ts";
import { antigravityAccount } from "../antigravity/account.ts";
import { codexAccount } from "../codex/account.ts";
import { claudeAccount } from "../claude/account.ts";
import { xaiAccount } from "../xai/account.ts";
import type { OAuthProviderType } from "./schema.ts";
import {
  providerState,
  type AccountProvider,
  type AccountState,
  type AccountServices,
} from "./provider.ts";

/** Composition only: account protocols and business rules belong to each provider. */
export function accountProvider(
  type: OAuthProviderType,
  state: AccountState,
  services: AccountServices,
): AccountProvider {
  switch (type) {
    case ProviderType.Antigravity:
      return antigravityAccount(providerState(state, type), services);
    case ProviderType.Codex:
      return codexAccount(providerState(state, type), services);
    case ProviderType.Claude:
      return claudeAccount(providerState(state, type), services);
    case ProviderType.Xai:
      return xaiAccount(providerState(state, type), services);
  }
}
