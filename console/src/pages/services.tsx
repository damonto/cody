import { ServiceForm } from "@/features/services/service-form";
import { removeService } from "@/features/services/mutations";
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

export default function Services() {
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
  const edit = (index: number) =>
    setEditor({ snapshot: structuredClone(draft.data), index });
  const referencedBy = remove
    ? config.api_keys
        .filter((client) => client.services.includes(remove))
        .map((client) => client.id)
    : [];
  return (
    <>
      <PageHeading
        title="Services"
        description="Manage upstream providers, real model names, and prioritized credentials."
      >
        <Button onClick={() => edit(-1)}>
          <Plus />
          Add service
        </Button>
      </PageHeading>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["Configured services", config.services.length],
          [
            "Enabled services",
            config.services.filter((service) => !service.disabled).length,
          ],
          [
            "Upstream models",
            new Set(config.services.flatMap((service) => service.models)).size,
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
        {!config.services.length ? (
          <Empty
            title="Add your first upstream"
            action={
              <Button onClick={() => edit(-1)}>
                <Plus />
                Add service
              </Button>
            }
          >
            Connect a provider, declare its models, and add an upstream API key.
          </Empty>
        ) : (
          <DataTable
            data={config.services}
            columns={[
              {
                id: "service",
                header: "Service",
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
                id: "keys",
                header: "Keys",
                cell: ({ row }) =>
                  `${row.original.keys.filter((key) => !key.disabled).length} / ${row.original.keys.length} enabled`,
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
                          config.services.findIndex(
                            (service) => service.id === row.original.id,
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
                      onClick={() => setRemove(row.original.id)}
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
        Routing selects the highest-priority available service, then its
        highest-priority enabled key. Equal priorities follow configuration
        order.
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
              {editor?.index === -1 ? "Add service" : "Configure service"}
            </DialogTitle>
            <DialogDescription>
              Save these changes to your draft, then publish when ready.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <ServiceForm
              snapshot={editor.snapshot}
              index={editor.index}
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
            <AlertDialogTitle>Remove {remove}?</AlertDialogTitle>
            <AlertDialogDescription>
              The service and its pricing policies will be removed from the
              draft.{" "}
              {referencedBy.length
                ? `Update clients ${referencedBy.join(", ")} and any model routes before publishing.`
                : "Check model routes for references before publishing."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!remove) return;
                const next = removeService(config, remove);
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
