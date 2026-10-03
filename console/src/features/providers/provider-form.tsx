import { ProviderType } from "../../../../src/config/values.ts";

import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { type ProviderResources } from "@/lib/resources";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  newProvider,
  providerEditorSchema,
  providerFormOptions,
  providerFormValues,
} from "./form-options";
import { useSaveProvider } from "./api";
import { ConnectionFields } from "./connection-fields";
import { CredentialFields } from "./credential-fields";
import { CapabilityFields } from "./capability-fields";

export function ProviderForm({
  snapshot,
  index,
  configurationVersion,
  close,
}: {
  snapshot: ProviderResources;
  index: number;
  configurationVersion: number;
  close: () => void;
}) {
  const save = useSaveProvider();
  const [current] = useState(() => {
    if (index === -1) return newProvider();
    const provider = snapshot.providers[index];
    if (!provider || provider.type !== ProviderType.AiGateway)
      throw new Error("Provider is missing from the editing snapshot");
    return providerFormValues(provider);
  });
  const form = useAppForm({
    ...providerFormOptions,
    defaultValues: current,
    onSubmit: async ({ value }) => {
      try {
        await save.mutateAsync({
          provider: providerEditorSchema.parse(value),
          id: index === -1 ? null : current.id,
          version: snapshot.version,
        });
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
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="routing">Capabilities & retry</TabsTrigger>
        </TabsList>
        <ConnectionFields
          form={form}
          index={index}
          close={close}
          groups={snapshot.groups}
        />
        <CredentialFields
          form={form}
          providerId={current.id}
          version={snapshot.version}
          configurationVersion={configurationVersion}
          groups={snapshot.groups}
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
