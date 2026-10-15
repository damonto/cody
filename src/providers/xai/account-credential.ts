import type { z } from "zod";
import type { ProviderType } from "../../config/values.ts";
import {
  unavailableIdentity,
  type AccountSnapshotFor,
} from "../oauth/provider.ts";
import type { xaiCredentialSchema } from "./account-schema.ts";

export function xaiAccountCredential(
  account: AccountSnapshotFor<typeof ProviderType.Xai>,
): z.output<typeof xaiCredentialSchema> {
  if (!account.xai || !account.tokens) return unavailableIdentity();
  return {
    token: account.tokens.access_token,
    xai_subject: account.xai.subject,
    generation: account.generation,
  };
}
