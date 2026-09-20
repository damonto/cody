import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
  AntigravityProviderConfig,
  ProxyGroupConfig,
} from "../../../../src/config/types";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../../../src/shared/concurrency";
import { useAppForm } from "@/lib/form";
import { fieldErrors } from "@/lib/form-errors";
import { Choice, ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accountsOptions, cacheAccounts, refreshModels } from "./api";
import {
  applySettings,
  settingsEditorSchema,
  settingsFormValues,
} from "./form-options";

export function AntigravitySettingsForm({
  provider,
  groups,
  pending,
  onSave,
  close,
}: {
  provider: AntigravityProviderConfig;
  groups: ProxyGroupConfig[];
  pending: boolean;
  onSave: (provider: AntigravityProviderConfig) => Promise<void>;
  close: () => void;
}) {
  const cache = useQueryClient();
  const accounts = useQuery(accountsOptions("antigravity"));
  const [initial] = useState(() => settingsFormValues(provider));
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: settingsEditorSchema },
    onSubmit: async ({ value }) => {
      try {
        await onSave(applySettings(provider, value));
      } catch {
        /* The dialog keeps settings and shows the failed mutation. */
      }
    },
  });
  const ready =
    accounts.data?.filter((account) => account.status === "ready") ?? [];
  const discover = useMutation({
    mutationFn: () =>
      mapWithConcurrency(ready, PROVIDER_FAN_OUT_CONCURRENCY, (account) =>
        refreshModels(account.account_ref),
      ),
    onSuccess: (values) => cacheAccounts(cache, values),
  });
  const models = new Map(provider.models.map((id) => [id, id]));
  for (const account of accounts.data ?? []) {
    for (const model of account.models)
      models.set(model.id, model.display_name);
  }
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
        <Tabs defaultValue="general">
          <TabsList className="w-full">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="routing">Routing & retry</TabsTrigger>
          </TabsList>
          <TabsContent
            value="general"
            forceMount
            className="space-y-4 data-[state=inactive]:hidden"
          >
            <form.AppField name="disabled">
              {(field) => (
                <field.ToggleField label="Provider enabled" inverse />
              )}
            </form.AppField>
            <form.AppField name="priority">
              {(field) => <field.NumberField label="Priority" />}
            </form.AppField>
            <form.AppField name="proxy_group">
              {(field) => <field.ProxyGroupField groups={groups} />}
            </form.AppField>
          </TabsContent>
          <TabsContent
            value="models"
            forceMount
            className="space-y-4 data-[state=inactive]:hidden"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Upstream models</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!ready.length || discover.isPending}
                onClick={() => discover.mutate()}
              >
                <RefreshCw /> Discover models
              </Button>
            </div>
            {accounts.error && (
              <ErrorNotice
                error={accounts.error}
                retry={() => void accounts.refetch()}
              />
            )}
            {discover.error && (
              <ErrorNotice
                error={discover.error}
                retry={() => discover.mutate()}
              />
            )}
            {(accounts.data ?? [])
              .filter((account) => account.models_error)
              .map((account) => (
                <p
                  key={account.account_ref}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {account.models_error}
                </p>
              ))}
            <form.AppField name="models">
              {(field) => (
                <>
                  {models.size ? (
                    <div className="grid max-h-80 gap-3 overflow-auto rounded-md border p-3">
                      {[...models].map(([id, label]) => (
                        <Label
                          key={id}
                          className="flex items-center gap-3 text-sm"
                        >
                          <Checkbox
                            checked={field.state.value.includes(id)}
                            onCheckedChange={(checked) =>
                              field.handleChange(
                                checked
                                  ? [...field.state.value, id]
                                  : field.state.value.filter(
                                      (value) => value !== id,
                                    ),
                              )
                            }
                          />
                          <span>
                            {label}
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {id}
                            </span>
                          </span>
                        </Label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Authorize an account to discover models.
                    </p>
                  )}
                  <FieldError errors={fieldErrors(field)} />
                </>
              )}
            </form.AppField>
          </TabsContent>
          <TabsContent
            value="routing"
            forceMount
            className="space-y-4 data-[state=inactive]:hidden"
          >
            <form.AppField name="routes" mode="array">
              {(routes) => (
                <div className="space-y-3">
                  {routes.state.value.map((route, index) => (
                    <div
                      key={route.rowId}
                      className="grid items-start gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]"
                    >
                      <form.AppField name={`routes[${index}].alias`}>
                        {(field) => (
                          <field.TextField label="Client model name" />
                        )}
                      </form.AppField>
                      <form.AppField name={`routes[${index}].model`}>
                        {(field) => (
                          <>
                            <form.Subscribe
                              selector={(state) => state.values.models}
                            >
                              {(selected) => (
                                <Choice
                                  label="Upstream model"
                                  value={field.state.value}
                                  onChange={field.handleChange}
                                  options={[
                                    ...new Set([
                                      ...selected,
                                      ...(field.state.value
                                        ? [field.state.value]
                                        : []),
                                    ]),
                                  ].map((model) => ({
                                    value: model,
                                    label: model,
                                  }))}
                                />
                              )}
                            </form.Subscribe>
                            <FieldError errors={fieldErrors(field)} />
                          </>
                        )}
                      </form.AppField>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove route ${index + 1}`}
                        onClick={() => routes.removeValue(index)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      routes.pushValue({
                        rowId: crypto.randomUUID(),
                        alias: "",
                        model: form.state.values.models[0] ?? "",
                      })
                    }
                  >
                    <Plus />
                    Add model route
                  </Button>
                  <FieldError errors={fieldErrors(routes)} />
                </div>
              )}
            </form.AppField>
            <form.AppField name="retry">
              {(field) => (
                <div className="space-y-3 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      field.handleChange(
                        field.state.value
                          ? undefined
                          : { status_codes: [503], delays_ms: [1000] },
                      )
                    }
                  >
                    {field.state.value ? "Disable retries" : "Enable retries"}
                  </Button>
                  {field.state.value && (
                    <>
                      <form.AppField name="retry.status_codes">
                        {(codes) => (
                          <codes.NumberListField label="Retry HTTP status codes" />
                        )}
                      </form.AppField>
                      <form.AppField name="retry.delays_ms">
                        {(delays) => (
                          <delays.NumberListField label="Retry delays (milliseconds)" />
                        )}
                      </form.AppField>
                      <FieldError errors={fieldErrors(field)} />
                    </>
                  )}
                </div>
              )}
            </form.AppField>
          </TabsContent>
        </Tabs>
        <form.AppForm>
          <form.Errors />
        </form.AppForm>
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            Save settings
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
