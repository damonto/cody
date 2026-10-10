import {
  publicProviderModels,
  publicProviderModel,
  supportsProviderModel,
} from "../../../src/shared/antigravity-models.ts";
import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { useSaveModelRoutes } from "@/features/routing/api";
import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { routeFormSchema } from "../../../src/shared/forms";
import { useRoutingResources, type RoutingResources } from "@/lib/resources";
import {
  GLOBAL_SCOPE_KEY,
  parseScope,
  routesFor,
  scopeKey,
  scopeProviders,
  type RouteScope,
} from "@/features/routing/scope";
import {
  Choice,
  DataTable,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
} from "@/components/common";
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
import { Field, FieldLabel } from "@/components/ui/field";

function publicTargetModel(
  providers: RoutingResources["providers"],
  model: string,
): string {
  const provider = providers.find((entry) => entry.models.includes(model));
  return provider ? publicProviderModel(provider, model) : model;
}

export default function Routing() {
  const configuration = useRoutingResources();
  const save = useSaveModelRoutes();
  const [scopeChoice, setScopeChoice] = useState(GLOBAL_SCOPE_KEY);
  const [editor, setEditor] = useState<{
    snapshot: RoutingResources;
    alias: string;
    scope: RouteScope;
  } | null>(null);
  if (configuration.isPending) return <Loading />;
  if (configuration.error)
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  const config = configuration.data;
  const providerNames = new Map(
    config.providers.map((provider) => [provider.id, provider.name]),
  );
  const choices = [
    { value: GLOBAL_SCOPE_KEY, label: "Global routes" },
    ...config.providers.map((provider) => ({
      value: scopeKey({ kind: "provider", id: provider.id }),
      label: `Provider · ${provider.name ?? provider.id}`,
    })),
    ...config.clients.map((client) => ({
      value: scopeKey({ kind: "client", id: client.id }),
      label: `Client · ${client.name ?? client.id}`,
    })),
  ];
  const selected = choices.some((choice) => choice.value === scopeChoice)
    ? scopeChoice
    : GLOBAL_SCOPE_KEY;
  const scope = parseScope(selected);
  const rows = Object.entries(routesFor(config, scope)).map(
    ([alias, route]) => ({ alias, ...route }),
  );
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Model routes"
        description="Map client model names to provider models."
      >
        <Button
          disabled={!config.providers.length}
          onClick={() =>
            setEditor({
              snapshot: structuredClone(configuration.data),
              alias: "",
              scope,
            })
          }
        >
          <Plus />
          Add route
        </Button>
      </PageHeading>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Choice
          label="Route scope"
          value={selected}
          onChange={setScopeChoice}
          options={choices}
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Provider</Badge>
          <ArrowRight className="size-3" />
          <Badge variant="outline">Client</Badge>
          <ArrowRight className="size-3" />
          <Badge variant="outline">Global</Badge>
          <span>Priority order</span>
        </div>
      </div>
      <Card className="overflow-hidden py-0 shadow-none">
        {rows.length ? (
          <DataTable
            data={rows}
            columns={[
              {
                id: "alias",
                header: "Client model name",
                cell: ({ row }) => (
                  <span className="font-mono text-xs">
                    {row.original.alias}
                  </span>
                ),
              },
              {
                id: "arrow",
                header: "",
                cell: () => (
                  <ArrowRight className="size-4 text-muted-foreground" />
                ),
              },
              {
                id: "model",
                header: "Model",
                cell: ({ row }) => (
                  <span className="font-mono text-xs">
                    {publicTargetModel(
                      scopeProviders(config, scope).filter(
                        (provider) =>
                          !row.original.providers ||
                          row.original.providers.includes(provider.id),
                      ),
                      row.original.model,
                    )}
                  </span>
                ),
              },
              {
                id: "providers",
                header: "Provider restriction",
                cell: ({ row }) => (
                  <span className="text-sm text-muted-foreground">
                    {(scope.kind === "provider"
                      ? [scope.id]
                      : row.original.providers
                    )
                      ?.map((id) => providerNames.get(id) ?? "Unknown provider")
                      .join(", ") ?? "Any permitted provider"}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "",
                cell: ({ row }) => (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setEditor({
                          snapshot: structuredClone(configuration.data),
                          alias: row.original.alias,
                          scope,
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove route ${row.original.alias}`}
                      disabled={save.isPending}
                      onClick={() => {
                        const routes = { ...routesFor(config, scope) };
                        delete routes[row.original.alias];
                        save.mutate({
                          scope,
                          routes,
                          version: configuration.data.version,
                        });
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
          <Empty title="No routes in this scope">
            Clients can use provider model names directly. Add a route to
            introduce an alias or restrict the permitted providers.
          </Empty>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        Route restrictions are intersected with the authenticated client’s
        allowed providers.
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
              {editor?.alias ? "Edit model route" : "Add model route"}
            </DialogTitle>
            <DialogDescription>
              Use only model names declared by the target upstream provider.
            </DialogDescription>
          </DialogHeader>
          {editor && <RouteForm {...editor} close={() => setEditor(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
function RouteForm({
  snapshot,
  scope,
  alias,
  close,
}: {
  snapshot: RoutingResources;
  scope: RouteScope;
  alias: string;
  close: () => void;
}) {
  const save = useSaveModelRoutes();
  const existing = routesFor(snapshot, scope)[alias];
  const availableProviders = scopeProviders(snapshot, scope);
  const models = [...new Set(availableProviders.flatMap(publicProviderModels))];
  const form = useAppForm({
    defaultValues: {
      alias,
      model: existing?.model ?? models[0] ?? "",
      providers: existing?.providers ?? [],
    },
    validators: { onSubmit: routeFormSchema },
    onSubmit: async ({ value }) => {
      const routes = { ...routesFor(snapshot, scope) };
      const parsed = routeFormSchema.parse(value);
      if (parsed.alias !== alias && Object.hasOwn(routes, parsed.alias)) {
        toast.error("This alias already exists in this scope");
        return;
      }
      if (alias && parsed.alias !== alias) delete routes[alias];
      routes[parsed.alias] = {
        ...(existing?.id ? { id: existing.id } : {}),
        model: parsed.model,
        ...(scope.kind !== "provider" && parsed.providers.length
          ? { providers: parsed.providers }
          : {}),
      };
      try {
        await save.mutateAsync({ routes, scope, version: snapshot.version });
        close();
      } catch {
        /* Preserve unsaved values. */
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
      <form.AppField name="alias">
        {(field) => (
          <field.TextField
            label="Client model name"
            placeholder="my-model-alias"
          />
        )}
      </form.AppField>
      <form.AppField name="model">
        {(field) => (
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Choice
              label="Model"
              value={publicTargetModel(availableProviders, field.state.value)}
              onChange={(value) => {
                field.handleChange(value);
                form.setFieldValue("providers", []);
              }}
              options={models.map((model) => ({
                value: model,
                label: model,
              }))}
            />
          </Field>
        )}
      </form.AppField>
      {scope.kind !== "provider" && (
        <form.Subscribe selector={(state) => state.values.model}>
          {(model) => (
            <form.AppField name="providers">
              {(field) => (
                <Field>
                  <FieldLabel>Restrict to providers</FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    Leave all unchecked to allow any permitted provider
                    supporting this model.
                  </p>
                  {availableProviders
                    .filter((provider) =>
                      supportsProviderModel(provider, model),
                    )
                    .map((provider) => (
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
                </Field>
              )}
            </form.AppField>
          )}
        </form.Subscribe>
      )}
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button disabled={submitting} type="submit">
              Save route
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
