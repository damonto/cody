import { CodexAccountSelection } from "../../../../src/config/values.ts";

import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ProxyGroupConfig } from "../../../../src/config/types";
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
import {
  accountsOptions,
  cacheAccounts,
  refreshModels,
} from "@/features/oauth-accounts/api";
import {
  applySettings,
  settingsEditorSchema,
  settingsFormValues,
  type SubscriptionProvider,
} from "./subscription-settings";

export function SubscriptionSettingsForm<
  Provider extends SubscriptionProvider,
>({
  provider,
  groups,
  pending,
  onSave,
  close,
}: {
  provider: Provider;
  groups: ProxyGroupConfig[];
  pending: boolean;
  onSave: (provider: Provider) => Promise<void>;
  close: () => void;
}) {
  const cache = useQueryClient();
  const accounts = useQuery(accountsOptions(provider.id));
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
    accounts.data?.filter(
      (account) => account.status === OAuthAccountViewStatus.Ready,
    ) ?? [];
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
            <form.AppField name="account_selection">
              {(field) => (
                <div className="space-y-2">
                  <Label>Account selection</Label>
                  <Choice
                    label="Account selection"
                    value={
                      field.state.value ?? CodexAccountSelection.RoundRobin
                    }
                    onChange={(value) =>
                      field.handleChange(
                        value === CodexAccountSelection.SessionAffinity
                          ? CodexAccountSelection.SessionAffinity
                          : CodexAccountSelection.RoundRobin,
                      )
                    }
                    options={[
                      {
                        value: CodexAccountSelection.RoundRobin,
                        label: "Round robin",
                      },
                      {
                        value: CodexAccountSelection.SessionAffinity,
                        label: "Session affinity (fill first)",
                      },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">
                    Round robin spreads new sessions across accounts. Session
                    affinity fills one account before using the next. Either way
                    a session keeps its account until its quota runs out.
                  </p>
                </div>
              )}
            </form.AppField>
            <form.AppField name="allow_extra_usage">
              {(field) => (
                <field.ToggleField
                  label="Allow Extra Usage"
                  hint="Use already-enabled paid usage only after all subscription quotas are exhausted. Concurrent requests may cross quota boundaries; this is not a billing cap."
                />
              )}
            </form.AppField>
            {provider.type === "xai" && (
              <form.AppField name="inject_x_search">
                {(field) => (
                  <field.ToggleField
                    label="Enable native X Search"
                    hint="Allow Grok to search X using its hosted search tool. Disabled by default, matching CLIProxyAPI."
                  />
                )}
              </form.AppField>
            )}
          </TabsContent>
          <TabsContent
            value="models"
            forceMount
            className="space-y-4 data-[state=inactive]:hidden"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Models</p>
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
                      Authorize an account to load its model catalog.
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
                                  label="Model"
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
                      <form.AppField name="retry.error_codes">
                        {(codes) => (
                          <codes.StringListField
                            label="Retry error codes"
                            hint="Optional JSON or early SSE error codes, e.g. rate_limit_exceeded. Quota limits follow account switching rules."
                          />
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
