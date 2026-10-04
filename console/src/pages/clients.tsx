import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { useSaveClient, useDeleteClient } from "@/features/clients/api";
import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { clientFormSchema } from "../../../src/shared/forms";
import { createClientKey } from "../../../src/shared/secrets";
import type { ClientApiKeyConfig } from "../../../src/config/types";
import { useClientResources, type ClientResources } from "@/lib/resources";
import {
  DataTable,
  Empty,
  ErrorNotice,
  fieldErrors,
  Loading,
  PageHeading,
} from "@/components/common";
import {
  ClientCredential,
  ClientCredentialField,
} from "@/features/clients/credential";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ClientEditor {
  snapshot: ClientResources;
  index: number;
  initial: ClientApiKeyConfig;
}

interface ClientFormProps extends ClientEditor {
  configurationVersion: number;
  close: () => void;
}

export default function Clients() {
  const configuration = useClientResources();
  const save = useDeleteClient();
  const [editor, setEditor] = useState<ClientEditor | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  if (configuration.isPending) return <Loading />;
  if (configuration.error)
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  const currentConfiguration = configuration.data;
  function edit(index: number) {
    const snapshot = structuredClone(currentConfiguration);
    const initial =
      index === -1
        ? {
            id: `new-${crypto.randomUUID()}`,
            name: "",
            api_key: createClientKey(),
            providers: snapshot.providers.map((provider) => provider.id),
          }
        : snapshot.clients[index];
    setEditor({ snapshot, index, initial });
  }
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Client keys"
        description="Issue gateway credentials and choose which upstream providers each client may use."
      >
        <Button
          onClick={() => edit(-1)}
          disabled={!configuration.data.providers.length}
        >
          <Plus />
          Create client
        </Button>
      </PageHeading>
      <Card className="overflow-hidden py-0 shadow-none">
        {configuration.data.clients.length ? (
          <DataTable
            data={configuration.data.clients}
            columns={[
              {
                id: "client",
                header: "Client",
                cell: ({ row }) => (
                  <span className="flex items-center gap-3 font-medium">
                    <KeyRound className="size-4 text-muted-foreground" />
                    {row.original.name ?? row.original.id}
                  </span>
                ),
              },
              {
                id: "secret",
                header: "Credential",
                cell: ({ row }) => (
                  <ClientCredential
                    key={`${row.original.id}:${configuration.data.version}`}
                    clientId={row.original.id}
                    version={configuration.data.version}
                    value={row.original.api_key}
                  />
                ),
              },
              {
                id: "providers",
                header: "Allowed providers",
                cell: ({ row }) => (
                  <div className="flex flex-wrap gap-1">
                    {row.original.providers.length === 0 && (
                      <span className="text-sm text-muted-foreground">
                        No providers — no upstream access
                      </span>
                    )}
                    {row.original.providers.map((id) => (
                      <Badge
                        key={id}
                        variant="secondary"
                        className="font-normal"
                      >
                        {configuration.data.providers.find(
                          (provider) => provider.id === id,
                        )?.name ?? id}
                      </Badge>
                    ))}
                  </div>
                ),
              },
              {
                id: "routes",
                header: "Model routes",
                cell: ({ row }) =>
                  Object.keys(row.original.model_routes ?? {}).length,
              },
              {
                id: "action",
                header: "",
                cell: ({ row }) => (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        edit(
                          configuration.data.clients.findIndex(
                            (client) => client.id === row.original.id,
                          ),
                        )
                      }
                    >
                      Edit client
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${row.original.name ?? row.original.id}`}
                      onClick={() => {
                        save.reset();
                        setRemove(row.original.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <Empty title="Give your first client access">
            {configuration.data.providers.length
              ? "Create a client credential and select its allowed providers."
              : "Add an upstream provider first, then create a client key."}
          </Empty>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        Names can be changed. Request history and session ownership use a
        system-generated ID.
      </p>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.index === -1 ? "Create client" : "Edit client"}
            </DialogTitle>
            <DialogDescription>
              New and rotated credentials take effect when saved. Copy saved
              credentials from the client list.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <ClientForm
              {...editor}
              configurationVersion={configuration.data.version}
              close={() => setEditor(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={remove !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove client{" "}
              {
                configuration.data.clients.find(
                  (client) => client.id === remove,
                )?.name
              }
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The credential stops working immediately. Historical request
              records remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {save.error && <ErrorNotice error={save.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!remove) return;
                save.mutate(
                  { id: remove, version: configuration.data.version },
                  { onSuccess: () => setRemove(null) },
                );
              }}
            >
              Remove client
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function ClientForm({
  snapshot,
  index,
  initial,
  configurationVersion,
  close,
}: ClientFormProps) {
  const save = useSaveClient();
  const form = useAppForm({
    defaultValues: initial,
    validators: { onBlur: clientFormSchema, onSubmit: clientFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await save.mutateAsync({
          client: value,
          id: index === -1 ? null : initial.id,
          version: snapshot.version,
        });
        close();
      } catch {
        /* Keep the unsaved form open. */
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
      className="space-y-5"
    >
      <form.AppField name="name">
        {(field) => (
          <field.TextField label="Client name" placeholder="my-codex-client" />
        )}
      </form.AppField>
      <form.AppField name="api_key">
        {(field) => (
          <ClientCredentialField
            key={`${initial.id}:${snapshot.version}:${configurationVersion}`}
            clientId={initial.id}
            version={snapshot.version}
            value={field.state.value}
            onChange={field.handleChange}
            onBlur={field.handleBlur}
            errors={fieldErrors(field)}
          />
        )}
      </form.AppField>
      <form.AppField name="providers">
        {(field) => (
          <Field>
            <FieldLabel>Allowed providers</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {snapshot.providers.map((provider) => (
                <label
                  key={provider.name ?? provider.id}
                  className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                >
                  <Checkbox
                    checked={field.state.value.includes(provider.id)}
                    onCheckedChange={(checked) =>
                      field.handleChange(
                        checked === true
                          ? [...field.state.value, provider.id]
                          : field.state.value.filter(
                              (id) => id !== provider.id,
                            ),
                      )
                    }
                  />
                  {provider.name ?? provider.id}
                </label>
              ))}
            </div>
            {field.state.value.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This client has no upstream access until a provider is selected.
              </p>
            )}
            <FieldError errors={fieldErrors(field)} />
          </Field>
        )}
      </form.AppField>
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              Save client
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
