import type { z } from "zod";
import type { ProviderType } from "../../config/values.ts";
import {
  unavailableIdentity,
  type AccountSnapshotFor,
} from "../oauth/provider.ts";
import type { codexCredentialSchema } from "./account-schema.ts";

export function codexAccountCredential(
  account: AccountSnapshotFor<typeof ProviderType.Codex>,
): z.output<typeof codexCredentialSchema> {
  if (!account.codex || !account.tokens) return unavailableIdentity();
  if (account.codex.mode === "siwc") {
    if (!account.codex.siwc || !account.codex.plan_usage_enabled)
      return unavailableIdentity();
    return {
      mode: "siwc",
      token: account.tokens.access_token,
      siwc_subject: account.codex.siwc.subject,
      generation: account.generation,
    };
  }
  return {
    token: account.tokens.access_token,
    account_id: account.codex.account_id,
    generation: account.generation,
    ...(account.codex.is_fedramp ? { is_fedramp: true } : {}),
  };
}
