import { reportQuerySchema } from "../../../src/admin/schema";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Choice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDraft } from "@/lib/api";

export function useReportFilters() {
  const [search, setSearch] = useSearchParams();
  const raw = Object.fromEntries(search);
  const parsed = reportQuerySchema.safeParse(raw);
  const filters = parsed.success ? parsed.data : reportQuerySchema.parse({});
  const { limit, ...rest } = filters;
  const values = { ...rest, limit: String(limit) };
  const change = (key: string, value: string) =>
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("cursor");
      if (key === "service_id") next.delete("model");
      return next;
    });
  return { values, change };
}
export function ReportFilters({
  refresh,
  fetching = false,
  requests = false,
  timeZone,
}: {
  refresh: () => void;
  fetching?: boolean;
  requests?: boolean;
  timeZone?: string;
}) {
  const { values, change } = useReportFilters();
  const draft = useDraft();
  const services = draft.data?.config.services ?? [];
  const models = [
    ...new Set(
      services
        .filter(
          (service) => !values.service_id || service.id === values.service_id,
        )
        .flatMap((service) => service.models),
    ),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={values.period}
          onValueChange={(value) => change("period", value)}
        >
          <TabsList>
            {[
              ["day", "Today"],
              ["week", "This week"],
              ["month", "This month"],
              ["total", "Total"],
            ].map(([value, title]) => (
              <TabsTrigger key={value} value={value}>
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {timeZone ??
              draft.data?.config.reporting?.time_zone ??
              "Asia/Shanghai"}
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh report"
            onClick={refresh}
            disabled={fetching}
          >
            <RefreshCw className={fetching ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Choice
          label="Filter by service"
          value={values.service_id ?? ""}
          onChange={(value) => change("service_id", value)}
          options={[
            { value: "", label: "All services" },
            ...services.map((service) => ({
              value: service.id,
              label: service.id,
            })),
          ]}
        />
        <Choice
          label="Filter by model"
          value={values.model ?? ""}
          onChange={(value) => change("model", value)}
          options={[
            { value: "", label: "All models" },
            ...models.map((model) => ({ value: model, label: model })),
          ]}
        />
        <Choice
          label="Filter by client"
          value={values.client_id ?? ""}
          onChange={(value) => change("client_id", value)}
          options={[
            { value: "", label: "All clients" },
            ...(draft.data?.config.api_keys ?? []).map((client) => ({
              value: client.id,
              label: client.id,
            })),
          ]}
        />
        {requests && (
          <>
            <Choice
              label="Filter by outcome"
              value={values.outcome ?? ""}
              onChange={(value) => change("outcome", value)}
              options={[
                { value: "", label: "All outcomes" },
                ...[
                  "success",
                  "failed",
                  "pending",
                  "cancelled",
                  "incomplete",
                ].map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                })),
              ]}
            />
            <Choice
              label="Filter by request kind"
              value={values.kind ?? ""}
              onChange={(value) => change("kind", value)}
              options={[
                { value: "", label: "All request types" },
                ...["inference", "handshake"].map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                })),
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
