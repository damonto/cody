import { z } from "zod";
import { oauthCredentialSchema } from "../../../../src/config/schema";
import { CredentialAuthType } from "../../../../src/config/values";
export const accountEditorSchema = oauthCredentialSchema.extend({
  rowId: z.string().min(1),
  auth: oauthCredentialSchema.shape.auth.extend({
    account_ref: z.uuid({
      error: "Authorize or select an account before saving.",
    }),
  }),
});
export type AccountFormValues = z.input<typeof accountEditorSchema>;

export function newAccount(): AccountFormValues {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    id: `account-${rowId}`,
    priority: 100,
    disabled: false,
    auth: { type: CredentialAuthType.OAuth, account_ref: "" },
  };
}
