import { useResourceEditor } from "@/lib/use-resource-editor";
import { ResourceConflict } from "@/components/form/resource-conflict";
import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { useSaveReporting, useSaveWebSearch } from "@/features/settings/api";
import { useState } from "react";
import { useAppForm } from "@/lib/form";
import { z } from "zod";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { reportingSchema } from "../../../src/billing/schema";
import { searchFormSchema } from "../../../src/shared/forms";
import { revealSearchKey } from "@/lib/api";
import { useSettingsResources, type SettingsResources } from "@/lib/resources";
import { Choice, ErrorNotice, Loading, PageHeading } from "@/components/common";
import { CredentialField } from "@/components/form/credential-field";
import { fieldErrors } from "@/lib/form-errors";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";

export default function Settings() {
  const configuration = useSettingsResources();
  if (configuration.isPending) return <Loading />;
  if (configuration.error)
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Workspace settings"
        description="Configure reporting, retention, and gateway search behavior."
      >
        <Button
          variant="outline"
          onClick={() => void configuration.refetch()}
          disabled={configuration.isFetching}
        >
          <RefreshCw />
          Reload configuration
        </Button>
      </PageHeading>
      <Alert>
        <CheckCircle2 />
        <AlertTitle>Changes take effect when saved</AlertTitle>
        <AlertDescription>
          New requests use the latest saved configuration.
        </AlertDescription>
      </Alert>
      <ReportingSettings snapshot={configuration.data} />
      <SearchSettings snapshot={configuration.data} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>Data collection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Prompts, response content, and credentials are not stored in request
            history. Configuration secrets are encrypted and hidden when read
            back.
          </p>
          <p>
            Hourly usage aggregates remain available after request details
            expire. Historical charges retain the rates used at request time.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

const reportingFormSchema = z.object({ reporting: reportingSchema });
function ReportingSettings({ snapshot }: { snapshot: SettingsResources }) {
  const save = useSaveReporting();
  const editor = useResourceEditor({
    version: snapshot.version,
    item: snapshot.reporting,
    etag: snapshot.tags.reporting,
  });
  const form = useAppForm({
    defaultValues: {
      reporting: editor.initial,
    },
    validators: { onBlur: reportingFormSchema, onSubmit: reportingFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = await save.mutateAsync({
          reporting: reportingSchema.parse(value.reporting),
          version: editor.version,
        });
        const reporting = reportingSchema.parse(saved.item);
        editor.accept({ version: saved.version, item: reporting });
        formApi.reset({ reporting });
      } catch {
        /* Keep the reporting edits available for retry. */
      }
    },
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>Reporting</CardTitle>
          <CardDescription>
            Calendar periods use this time zone. Total includes all recorded
            usage, including aggregates whose request details have expired.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <form.AppField name="reporting.time_zone">
            {(field) => (
              <field.TextField
                label="Report time zone"
                placeholder="Asia/Shanghai"
                hint="An IANA time zone. Weeks start on Monday."
              />
            )}
          </form.AppField>
          <form.AppField name="reporting.retention_days">
            {(field) => (
              <field.NumberField
                label="Request detail retention (days)"

                hint="30–730 days. Cleanup runs hourly in bounded batches."
              />
            )}
          </form.AppField>
        </CardContent>
      </Card>
      <ResourceConflict
        conflict={editor.conflict}
        reload={() => {
          editor.accept({
            version: snapshot.version,
            item: snapshot.reporting,
            etag: snapshot.tags.reporting,
          });
          form.reset({ reporting: snapshot.reporting });
          save.reset();
        }}
      />
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting || editor.conflict}>
              Save reporting settings
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

const webSearchFormSchema = z.object({ web_search: searchFormSchema });
function SearchSettings({ snapshot }: { snapshot: SettingsResources }) {
  const [savedCount, setSavedCount] = useState(0);
  const save = useSaveWebSearch();
  const editor = useResourceEditor({
    version: snapshot.version,
    item: snapshot.search,
    etag: snapshot.tags.search,
  });
  const initial: z.input<typeof webSearchFormSchema> = {
    web_search: editor.initial,
  };
  const form = useAppForm({
    defaultValues: initial,
    validators: { onBlur: webSearchFormSchema, onSubmit: webSearchFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = await save.mutateAsync({
          web_search: searchFormSchema.parse(value.web_search),
          version: editor.version,
        });
        const web_search = searchFormSchema.parse(saved.item);
        editor.accept({ version: saved.version, item: web_search });
        formApi.reset({ web_search });
        setSavedCount((count) => count + 1);
      } catch {
        /* Keep the search edits available for retry. */
      }
    },
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>Web search</CardTitle>
          <CardDescription>
            Use upstream-native search or a dedicated search provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form.AppField name="web_search">
            {(field) => (
              <>
                <Field>
                  <FieldLabel>Search mode</FieldLabel>
                  <Choice
                    label="Search mode"
                    value={field.state.value.mode}
                    onChange={(value) =>
                      field.handleChange(
                        value === "proxy"
                          ? { mode: "proxy" }
                          : {
                              mode: value === "exa" ? "exa" : "tavily",
                              base_url:
                                value === "exa"
                                  ? "https://api.exa.ai"
                                  : "https://api.tavily.com",
                              api_key: "",
                              max_results: 5,
                              prefer_native: false,
                            },
                      )
                    }
                    options={[
                      { value: "proxy", label: "Upstream native search" },
                      { value: "tavily", label: "Tavily" },
                      { value: "exa", label: "Exa" },
                    ]}
                  />
                </Field>
                {field.state.value.mode !== "proxy" && (
                  <>
                    <form.AppField name="web_search.prefer_native">
                      {(input) => (
                        <input.ToggleField
                          label="Prefer native search"
                          hint="Forward alpha/search to a provider with native web search when the client API key can reach one; otherwise use the configured search provider."
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="web_search.base_url">
                      {(input) => (
                        <input.TextField label="Search provider URL" />
                      )}
                    </form.AppField>
                    <form.AppField name="web_search.api_key">
                      {(input) => (
                        <CredentialField
                          key={`${field.state.value.mode}:${savedCount}:${snapshot.version}`}
                          label="Search API key"
                          name={input.name}
                          value={input.state.value ?? ""}
                          onChange={input.handleChange}
                          onBlur={input.handleBlur}
                          errors={fieldErrors(input)}
                          reveal={(signal) =>
                            revealSearchKey(editor.version, signal)
                          }
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="web_search.max_results">
                      {(input) => (
                        <input.NumberField label="Maximum search results" />
                      )}
                    </form.AppField>
                  </>
                )}
              </>
            )}
          </form.AppField>
        </CardContent>
      </Card>
      <ResourceConflict
        conflict={editor.conflict}
        reload={() => {
          editor.accept({
            version: snapshot.version,
            item: snapshot.search,
            etag: snapshot.tags.search,
          });
          form.reset({ web_search: snapshot.search });
          save.reset();
        }}
      />
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting || editor.conflict}>
              Save search settings
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
