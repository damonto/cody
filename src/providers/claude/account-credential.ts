import type { z } from "zod";
import type { ProviderType } from "../../config/values.ts";
import {
  unavailableIdentity,
  type AccountSnapshotFor,
} from "../oauth/provider.ts";
import type { claudeCredentialSchema } from "./account-schema.ts";

export function claudeAccountCredential(
  account: AccountSnapshotFor<typeof ProviderType.Claude>,
): z.output<typeof claudeCredentialSchema> {
  if (!account.claude || !account.tokens) return unavailableIdentity();
  return {
    token: account.tokens.access_token,
    claude_organization_id: account.claude.organization_id,
    generation: account.generation,
  };
}
