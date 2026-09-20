import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { useSaveDraft, type Draft } from "@/lib/api";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  newProvider,
  providerEditorSchema,
  providerFormOptions,
  providerFormValues,
} from "./form-options";
import { updateProvider } from "./mutations";
import { ConnectionFields } from "./connection-fields";
import { CredentialFields } from "./credential-fields";
import { CapabilityFields } from "./capability-fields";

export function ProviderForm({
  snapshot,
  index,
  draftVersion,
  close,
}: {
  snapshot: Draft;
  index: number;
  draftVersion: number;
  close: () => void;
}) {
  const save = useSaveDraft();
  const [current] = useState(() => {
    if (index === -1) return newProvider();
    const provider = snapshot.config.providers[index];
    if (!provider || provider.type !== "ai_gateway")
      throw new Error("Provider is missing from the editing snapshot");
    return providerFormValues(provider);
  });
  const form = useAppForm({
    ...providerFormOptions,
    defaultValues: current,
    onSubmit: async ({ value }) => {
      if (
        snapshot.config.providers.some(
          (provider, position) =>
            position !== index && provider.id === value.id,
        )
      ) {
        form.setFieldMeta("id", (meta) => ({
          ...meta,
          errorMap: { onSubmit: "A provider with this ID already exists" },
        }));
        return;
      }
      const next = updateProvider(
        snapshot.config,
        index,
        providerEditorSchema.parse(value),
      );
      try {
        await save.mutateAsync({ config: next, version: snapshot.version });
        close();
      } catch {
        /* The mutation displays the error and preserves form values. */
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
      className="space-y-6"
    >
      <Tabs defaultValue="connection">
        <TabsList className="w-full">
          <TabsTrigger value="connection">Connection</TabsTrigger>
          <TabsTrigger value="credentials">Upstream credentials</TabsTrigger>
          <TabsTrigger value="routing">Capabilities & retry</TabsTrigger>
        </TabsList>
        <ConnectionFields
          form={form}
          index={index}
          close={close}
          groups={snapshot.config.proxy_groups}
        />
        <CredentialFields
          form={form}
          providerId={current.id}
          version={snapshot.version}
          draftVersion={draftVersion}
          groups={snapshot.config.proxy_groups}
        />
        <CapabilityFields form={form} />
      </Tabs>
      {save.error && <ErrorNotice error={save.error} />}
      <form.Subscribe
        selector={(state) => ({
          submitting: state.isSubmitting,
        })}
      >
        {({ submitting }) => (
          <>
            <form.AppForm>
              <form.Errors />
            </form.AppForm>
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                Save provider
              </Button>
            </div>
          </>
        )}
      </form.Subscribe>
    </form>
  );
}
