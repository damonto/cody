import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { clientFormSchema } from "../../../src/shared/forms";
import { createClientKey } from "../../../src/shared/secrets";
import type { ClientApiKeyConfig } from "../../../src/config/types";
import { useDraft, useSaveDraft, type Draft } from "@/lib/api";
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
  snapshot: Draft;
  index: number;
  initial: ClientApiKeyConfig;
}

interface ClientFormProps extends ClientEditor {
  draftVersion: number;
  close: () => void;
}

export default function Clients() {
  const draft = useDraft();
  const save = useSaveDraft();
  const [editor, setEditor] = useState<ClientEditor | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const currentDraft = draft.data;
  function edit(index: number) {
    const snapshot = structuredClone(currentDraft);
    const initial =
      index === -1
        ? {
            id: "",
            api_key: createClientKey(),
            providers: snapshot.config.providers.map((provider) => provider.id),
          }
        : snapshot.config.api_keys[index];
    setEditor({ snapshot, index, initial });
  }
  return (
    <>
      <PageHeading
        title="Client keys"
        description="Issue gateway credentials and choose which upstream providers each client may use."
      >
        <Button
          onClick={() => edit(-1)}
          disabled={!draft.data.config.providers.length}
        >
          <Plus />
          Create client
        </Button>
      </PageHeading>
      <Card className="overflow-hidden py-0 shadow-none">
        {draft.data.config.api_keys.length ? (
          <DataTable
            data={draft.data.config.api_keys}
            columns={[
              {
                id: "client",
                header: "Client",
                cell: ({ row }) => (
                  <span className="flex items-center gap-3 font-medium">
                    <KeyRound className="size-4 text-muted-foreground" />
                    {row.original.id}
                  </span>
                ),
              },
              {
                id: "secret",
                header: "Credential",
                cell: ({ row }) => (
                  <ClientCredential
                    key={`${row.original.id}:${draft.data.version}`}
                    clientId={row.original.id}
                    version={draft.data.version}
                    value={row.original.api_key}
                  />
                ),
              },
              {
                id: "providers",
                header: "Allowed providers",
                cell: ({ row }) => (
                  <div className="flex flex-wrap gap-1">
                    {row.original.providers.map((id) => (
                      <Badge
                        key={id}
                        variant="secondary"
                        className="font-normal"
                      >
                        {id}
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
                          draft.data.config.api_keys.findIndex(
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
                      aria-label={`Remove ${row.original.id}`}
                      onClick={() => setRemove(row.original.id)}
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
            {draft.data.config.providers.length
              ? "Create a client credential and select its allowed providers."
              : "Add an upstream provider first, then create a client key."}
          </Empty>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        Keep Client IDs stable when rotating credentials. Request history and
        session ownership use the Client ID.
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
              New and rotated credentials take effect after publication. Copy
              saved credentials from the client list.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <ClientForm
              {...editor}
              draftVersion={draft.data.version}
              close={() => setEditor(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={remove !== null}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove client {remove}?</AlertDialogTitle>
            <AlertDialogDescription>
              The credential stops working after publication. Historical request
              records remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={() => {
                const next = structuredClone(draft.data.config);
                next.api_keys = next.api_keys.filter(
                  (client) => client.id !== remove,
                );
                save.mutate(
                  { config: next, version: draft.data.version },
                  { onSuccess: () => setRemove(null) },
                );
              }}
            >
              Remove from draft
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
  draftVersion,
  close,
}: ClientFormProps) {
  const save = useSaveDraft();
  const form = useAppForm({
    defaultValues: initial,
    validators: { onBlur: clientFormSchema, onSubmit: clientFormSchema },
    onSubmit: async ({ value }) => {
      const next = structuredClone(snapshot.config);
      if (
        next.api_keys.some(
          (client, position) => position !== index && client.id === value.id,
        )
      ) {
        toast.error("A client with this ID already exists");
        return;
      }
      if (index === -1) next.api_keys.push(value);
      else next.api_keys[index] = value;
      try {
        await save.mutateAsync({ config: next, version: snapshot.version });
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
      <form.AppField name="id">
        {(field) => (
          <field.TextField
            label="Client ID"
            readOnly={index !== -1}
            placeholder="my-codex-client"
          />
        )}
      </form.AppField>
      <form.AppField name="api_key">
        {(field) => (
          <ClientCredentialField
            key={`${initial.id}:${snapshot.version}:${draftVersion}`}
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
              {snapshot.config.providers.map((provider) => (
                <label
                  key={provider.id}
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
                  {provider.id}
                </label>
              ))}
            </div>
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
