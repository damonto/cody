import { useRef, useState } from "react";
import { useAppForm } from "@/lib/form";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { CheckCircle2, FileUp, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { reportingSchema } from "../../../src/billing/schema";
import { maskedConfigurationSchema } from "../../../src/config/schema";
import { searchFormSchema } from "../../../src/shared/forms";
import type { GatewayConfig } from "../../../src/config/types";
import {
  read,
  rpc,
  draftOptions,
  useDraft,
  useSaveDraft,
  type Draft,
} from "@/lib/api";
import { Choice, ErrorNotice, Loading, PageHeading } from "@/components/common";
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

const settingsSchema = z.object({
  reporting: reportingSchema,
  web_search: searchFormSchema,
});
export default function Settings() {
  const draft = useDraft();
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const importFile = async (selected: File) => {
    if (selected.size > 1024 * 1024) {
      toast.error("Configuration must be smaller than 1 MiB");
      return;
    }
    setImporting(true);
    try {
      const config = maskedConfigurationSchema.parse(
        JSON.parse(await selected.text()),
      );
      const next = await read(
        rpc.config.$put({ json: { config, version: draft.data.version } }),
      );
      queryClient.setQueryData(draftOptions.queryKey, next);
      toast.success("Configuration imported as a draft", {
        description: "Review it before publishing.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <>
      <PageHeading
        title="Workspace settings"
        description="Configure reporting, retention, and gateway search behavior."
      >
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void draft.refetch()}
            disabled={draft.isFetching}
          >
            <RefreshCw />
            Reload draft
          </Button>
          <input
            ref={file}
            className="hidden"
            type="file"
            accept="application/json,.json"
            aria-label="Import configuration JSON"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void importFile(selected);
            }}
          />
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => file.current?.click()}
          >
            <FileUp />
            Import JSON
          </Button>
        </div>
      </PageHeading>
      {draft.data.valid ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Draft is ready to publish</AlertTitle>
          <AlertDescription>
            Review your changes and use Publish to make this configuration
            active.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>Complete the draft before publishing</AlertTitle>
          <AlertDescription className="break-all">
            {draft.data.validation_error}
          </AlertDescription>
        </Alert>
      )}
      <SettingsForm key={draft.data.version} snapshot={draft.data} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>Data collection</CardTitle>
          <CardDescription>
            Request records include timing, routing identifiers, reported token
            counters, and price snapshots.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Prompts, response content, and credentials are not stored in request
            history. Secrets in configuration drafts are encrypted and hidden
            when read back.
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
function SettingsForm({ snapshot }: { snapshot: Draft }) {
  const save = useSaveDraft();
  const initial: z.input<typeof settingsSchema> = {
    reporting: snapshot.config.reporting ?? {
      time_zone: "Asia/Shanghai",
      retention_days: 120,
    },
    web_search: snapshot.config.web_search,
  };
  const form = useAppForm({
    defaultValues: initial,
    validators: { onBlur: settingsSchema, onSubmit: settingsSchema },
    onSubmit: async ({ value }) => {
      const next: GatewayConfig = {
        ...snapshot.config,
        ...settingsSchema.parse(value),
      };
      try {
        await save.mutateAsync({ config: next, version: snapshot.version });
      } catch {
        /* Display below. */
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

                hint="100–730 days. Cleanup runs hourly in bounded batches."
              />
            )}
          </form.AppField>
        </CardContent>
      </Card>
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
                    <form.AppField name="web_search.base_url">
                      {(input) => (
                        <input.TextField label="Search provider URL" />
                      )}
                    </form.AppField>
                    <form.AppField name="web_search.api_key">
                      {(input) => (
                        <input.TextField
                          label="Search API key"
                          type="password"
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
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              Save settings
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
