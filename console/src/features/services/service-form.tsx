import { useAppForm } from "@/lib/form";
import { useSaveDraft, type Draft } from "@/lib/api";
import { serviceFormSchema } from "../../../../src/shared/forms";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { newService, serviceFormOptions } from "./form-options";
import { updateService } from "./mutations";
import { ConnectionFields } from "./connection-fields";
import { CredentialFields } from "./credential-fields";
import { CapabilityFields } from "./capability-fields";

export function ServiceForm({
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
  const current = index === -1 ? newService() : snapshot.config.services[index];
  const form = useAppForm({
    ...serviceFormOptions,
    defaultValues: current,
    onSubmit: async ({ value }) => {
      if (
        snapshot.config.services.some(
          (service, position) => position !== index && service.id === value.id,
        )
      ) {
        form.setFieldMeta("id", (meta) => ({
          ...meta,
          errorMap: { onSubmit: "A service with this ID already exists" },
        }));
        return;
      }
      const next = updateService(
        snapshot.config,
        index,
        serviceFormSchema.parse(value),
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
          <TabsTrigger value="keys">Upstream keys</TabsTrigger>
          <TabsTrigger value="routing">Capabilities & retry</TabsTrigger>
        </TabsList>
        <ConnectionFields form={form} index={index} close={close} />
        <CredentialFields
          form={form}
          serviceId={current.id}
          version={snapshot.version}
          draftVersion={draftVersion}
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
                Save service
              </Button>
            </div>
          </>
        )}
      </form.Subscribe>
    </form>
  );
}
