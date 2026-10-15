import type { z } from "zod";
import type { ProviderType } from "../../config/values.ts";
import {
  unavailableIdentity,
  type AccountSnapshotFor,
} from "../oauth/provider.ts";
import type { antigravityCredentialSchema } from "./account-schema.ts";

export function antigravityAccountCredential(
  account: AccountSnapshotFor<typeof ProviderType.Antigravity>,
): z.output<typeof antigravityCredentialSchema> {
  if (!account.project_id || !account.tokens) return unavailableIdentity();
  return { token: account.tokens.access_token, project_id: account.project_id };
}
