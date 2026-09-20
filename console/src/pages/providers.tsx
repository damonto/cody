import { ProviderForm } from "@/features/providers/provider-form";
import { removeProvider } from "@/features/providers/mutations";
import { useState } from "react";
import { Plus, Server, Trash2 } from "lucide-react";
import { useDraft, useSaveDraft, type Draft } from "@/lib/api";
import {
  DataTable,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
  Status,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export default function Providers() {
  const draft = useDraft();
  const save = useSaveDraft();
  const [editor, setEditor] = useState<{
    snapshot: Draft;
    index: number;
  } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const config = draft.data.config;
  const providers = config.providers.filter(
    (provider) => provider.type === "ai_gateway",
  );
  const edit = (index: number) =>
    setEditor({ snapshot: structuredClone(draft.data), index });
  const referencedBy = remove
    ? config.api_keys
        .filter((client) => client.providers.includes(remove))
        .map((client) => client.id)
    : [];
  return (
    <>
      <PageHeading
        title="AI Gateway"
        description="Manage upstream providers, real model names, and prioritized credentials."
      >
        <Button onClick={() => edit(-1)}>
          <Plus />
          Add provider
        </Button>
      </PageHeading>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["Configured providers", providers.length],
          [
            "Enabled providers",
            providers.filter((provider) => !provider.disabled).length,
          ],
          [
            "Upstream models",
            new Set(providers.flatMap((provider) => provider.models)).size,
          ],
        ].map(([title, count]) => (
          <Card key={title} className="shadow-none">
            <CardContent className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">{title}</span>
              <span className="text-2xl font-semibold tabular-nums">
                {count}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden py-0 shadow-none">
        {!providers.length ? (
          <Empty
            title="Add your first upstream"
            action={
              <Button onClick={() => edit(-1)}>
                <Plus />
                Add provider
              </Button>
            }
          >
            Connect a provider, declare its models, and add an upstream API key.
          </Empty>
        ) : (
          <DataTable
            data={providers}
            columns={[
              {
                id: "provider",
                header: "Provider",
                cell: ({ row }) => (
                  <div className="flex items-center gap-3">
                    <span className="rounded-lg border p-2">
                      <Server className="size-4 text-muted-foreground" />
                    </span>
                    <div>
                      <p className="font-medium">{row.original.id}</p>
                      <p className="max-w-72 truncate text-xs text-muted-foreground">
                        {row.original.base_url}
                      </p>
                    </div>
                  </div>
                ),
              },
              {
                id: "type",
                header: "Type",
                cell: () => <Badge variant="secondary">AI Gateway</Badge>,
              },
              {
                id: "models",
                header: "Models",
                cell: ({ row }) => (
                  <div className="flex max-w-72 flex-wrap gap-1">
                    {row.original.models.slice(0, 3).map((model) => (
                      <Badge
                        key={model}
                        variant="secondary"
                        className="font-mono text-[10px] font-normal"
                      >
                        {model}
                      </Badge>
                    ))}
                    {row.original.models.length > 3 && (
                      <Badge variant="outline">
                        +{row.original.models.length - 3}
                      </Badge>
                    )}
                  </div>
                ),
              },
              {
                id: "credentials",
                header: "Credentials",
                cell: ({ row }) =>
                  `${row.original.credentials.filter((key) => !key.disabled).length} / ${row.original.credentials.length} enabled`,
              },
              {
                id: "priority",
                header: "Priority",
                cell: ({ row }) => row.original.priority,
              },
              {
                id: "state",
                header: "Status",
                cell: ({ row }) => (
                  <Status
                    value={row.original.disabled ? "disabled" : "enabled"}
                  />
                ),
              },
              {
                id: "edit",
                header: "",
                cell: ({ row }) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        edit(
                          config.providers.findIndex(
                            (provider) => provider.id === row.original.id,
                          ),
                        )
                      }
                    >
                      Configure
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${row.original.id}`}
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
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        Routing selects the highest-priority available provider, then its
        highest-priority enabled credential. Equal priorities follow
        configuration order.
      </p>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.index === -1 ? "Add provider" : "Configure provider"}
            </DialogTitle>
            <DialogDescription>
              Save these changes to your draft, then publish when ready.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <ProviderForm
              snapshot={editor.snapshot}
              index={editor.index}
              draftVersion={draft.data.version}
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
            <AlertDialogTitle>Remove {remove}?</AlertDialogTitle>
            <AlertDialogDescription>
              The provider and its pricing policies will be removed from the
              draft.{" "}
              {referencedBy.length
                ? `Update clients ${referencedBy.join(", ")} and any model routes before publishing.`
                : "Check model routes for references before publishing."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {save.error && <ErrorNotice error={save.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!remove) return;
                const next = removeProvider(config, remove);
                save.mutate(
                  { config: next, version: draft.data.version },
                  { onSuccess: () => setRemove(null) },
                );
              }}
              disabled={save.isPending}
            >
              Remove from draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
