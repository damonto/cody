import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { routeFormSchema } from "../../../src/shared/forms";
import type {
  GatewayConfig,
  ModelRouteConfig,
} from "../../../src/config/types";
import { useDraft, useSaveDraft, type Draft } from "@/lib/api";
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

function routesFor(
  config: GatewayConfig,
  scope: string,
): Record<string, ModelRouteConfig> {
  if (scope.startsWith("provider:"))
    return (
      config.providers.find((provider) => provider.id === scope.slice(8))
        ?.model_routes ?? {}
    );
  if (scope.startsWith("client:"))
    return (
      config.api_keys.find((client) => client.id === scope.slice(7))
        ?.model_routes ?? {}
    );
  return config.model_routes;
}
function setRoutes(
  config: GatewayConfig,
  scope: string,
  routes: Record<string, ModelRouteConfig>,
) {
  if (scope.startsWith("provider:")) {
    const provider = config.providers.find(
      (entry) => entry.id === scope.slice(8),
    );
    if (provider) provider.model_routes = routes;
  } else if (scope.startsWith("client:")) {
    const client = config.api_keys.find((entry) => entry.id === scope.slice(7));
    if (client) client.model_routes = routes;
  } else config.model_routes = routes;
}
export default function Routing() {
  const draft = useDraft();
  const save = useSaveDraft();
  const [scope, setScope] = useState("global");
  const [editor, setEditor] = useState<{
    snapshot: Draft;
    alias: string;
    scope: string;
  } | null>(null);
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const config = draft.data.config;
  const choices = [
    { value: "global", label: "Global routes" },
    ...config.providers.map((provider) => ({
      value: `provider:${provider.id}`,
      label: `Provider · ${provider.id}`,
    })),
    ...config.api_keys.map((client) => ({
      value: `client:${client.id}`,
      label: `Client · ${client.id}`,
    })),
  ];
  const selected = choices.some((choice) => choice.value === scope)
    ? scope
    : "global";
  const rows = Object.entries(routesFor(config, selected)).map(
    ([alias, route]) => ({ alias, ...route }),
  );
  return (
    <>
      <PageHeading
        title="Model routes"
        description="Map client-facing model names to real upstream models."
      >
        <Button
          disabled={!config.providers.length}
          onClick={() =>
            setEditor({
              snapshot: structuredClone(draft.data),
              alias: "",
              scope: selected,
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
          onChange={setScope}
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
                header: "Upstream model",
                cell: ({ row }) => (
                  <span className="font-mono text-xs">
                    {row.original.model}
                  </span>
                ),
              },
              {
                id: "providers",
                header: "Provider restriction",
                cell: ({ row }) => (
                  <span className="text-sm text-muted-foreground">
                    {selected.startsWith("provider:")
                      ? selected.slice(8)
                      : (row.original.providers?.join(", ") ??
                        "Any permitted provider")}
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
                          snapshot: structuredClone(draft.data),
                          alias: row.original.alias,
                          scope: selected,
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
                        const next = structuredClone(config);
                        const routes = { ...routesFor(next, selected) };
                        delete routes[row.original.alias];
                        setRoutes(next, selected, routes);
                        save.mutate({
                          config: next,
                          version: draft.data.version,
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
            Clients can use real model names directly. Add a route to introduce
            an alias or pin the permitted upstream providers.
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
  snapshot: Draft;
  scope: string;
  alias: string;
  close: () => void;
}) {
  const save = useSaveDraft();
  const existing = routesFor(snapshot.config, scope)[alias];
  const availableProviders = scope.startsWith("provider:")
    ? snapshot.config.providers.filter((entry) => entry.id === scope.slice(8))
    : scope.startsWith("client:")
      ? snapshot.config.providers.filter((entry) =>
          snapshot.config.api_keys
            .find((client) => client.id === scope.slice(7))
            ?.providers.includes(entry.id),
        )
      : snapshot.config.providers;
  const models = [
    ...new Set(availableProviders.flatMap((provider) => provider.models)),
  ];
  const form = useAppForm({
    defaultValues: {
      alias,
      model: existing?.model ?? models[0] ?? "",
      providers: existing?.providers ?? [],
    },
    validators: { onSubmit: routeFormSchema },
    onSubmit: async ({ value }) => {
      const next = structuredClone(snapshot.config);
      const routes = { ...routesFor(next, scope) };
      const parsed = routeFormSchema.parse(value);
      if (!alias && Object.hasOwn(routes, parsed.alias)) {
        toast.error("This alias already exists in this scope");
        return;
      }
      routes[parsed.alias] = {
        model: parsed.model,
        ...(!scope.startsWith("provider:") && parsed.providers.length
          ? { providers: parsed.providers }
          : {}),
      };
      setRoutes(next, scope, routes);
      try {
        await save.mutateAsync({ config: next, version: snapshot.version });
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
            readOnly={!!alias}
            placeholder="my-model-alias"
          />
        )}
      </form.AppField>
      <form.AppField name="model">
        {(field) => (
          <Field>
            <FieldLabel>Real upstream model</FieldLabel>
            <Choice
              label="Real upstream model"
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value);
                form.setFieldValue("providers", []);
              }}
              options={models.map((model) => ({ value: model, label: model }))}
            />
          </Field>
        )}
      </form.AppField>
      {!scope.startsWith("provider:") && (
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
                    .filter((provider) => provider.models.includes(model))
                    .map((provider) => (
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
