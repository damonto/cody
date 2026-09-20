import { useState } from "react";
import { useStore } from "@tanstack/react-form";
import type {
  AntigravityProviderConfig,
  ProxyGroupConfig,
} from "../../../../src/config/types";
import { useAppForm } from "@/lib/form";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";
import { Authorization } from "./authorization";
import { accountEditorSchema, applyAccount, newAccount } from "./form-options";

export function AccountForm({
  provider,
  credentialId,
  groups,
  version,
  draftVersion,
  pending,
  onSave,
  close,
}: {
  provider: AntigravityProviderConfig;
  credentialId?: string;
  groups: ProxyGroupConfig[];
  version: number;
  draftVersion: number;
  pending: boolean;
  onSave: (provider: AntigravityProviderConfig) => Promise<void>;
  close: () => void;
}) {
  const [initial] = useState(() => {
    if (!credentialId) return newAccount();
    const credential = provider.credentials.find(
      (entry) => entry.id === credentialId,
    );
    if (!credential)
      throw new Error("Account is missing from the editing snapshot");
    return { ...credential, rowId: crypto.randomUUID() };
  });
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: accountEditorSchema },
    onSubmit: async ({ value }) => {
      try {
        await onSave(applyAccount(provider, value));
      } catch {
        /* The dialog retains authorization and reports the failed save. */
      }
    },
  });
  const accountRef = useStore(
    form.store,
    (state) => state.values.auth.account_ref,
  );
  return (
    <form
      className="space-y-5"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <fieldset disabled={pending} className="min-w-0 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="priority">
            {(field) => <field.NumberField label="Account priority" />}
          </form.AppField>
          <form.AppField name="disabled">
            {(field) => <field.ToggleField label="Account enabled" inverse />}
          </form.AppField>
        </div>
        <form.AppField name="proxy_group">
          {(field) => (
            <>
              <field.ProxyGroupField inherit groups={groups} />
              <Authorization
                rowId={initial.rowId}
                accountRef={accountRef}
                connection={{
                  provider_id: "antigravity",
                  credential_id: initial.id,
                  provider_proxy_group: provider.proxy_group,
                  credential_proxy_group: field.state.value,
                }}
                version={version}
                draftVersion={draftVersion}
                occupied={provider.credentials
                  .filter((entry) => entry.id !== initial.id)
                  .map((entry) => entry.auth.account_ref)}
                onAuthorized={(ref) =>
                  form.setFieldValue("auth.account_ref", ref)
                }
              />
            </>
          )}
        </form.AppField>
        <form.AppField name="auth.account_ref">
          {(field) => <FieldError errors={fieldErrors(field)} />}
        </form.AppField>
        <form.AppForm>
          <form.Errors />
        </form.AppForm>
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !accountRef}>
            Save account
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
