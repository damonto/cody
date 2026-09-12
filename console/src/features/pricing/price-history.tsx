import { useQuery } from "@tanstack/react-query";
import type { PriceTier } from "../../../../src/billing/types";
import { read, rpc } from "@/lib/api";
import { date, number } from "@/lib/format";
import { DataTable, Empty, ErrorNotice, Loading } from "@/components/common";

export function PriceHistory({
  serviceId,
  model,
  enabled,
  timeZone,
}: {
  serviceId: string;
  model: string;
  enabled: boolean;
  timeZone?: string;
}) {
  const history = useQuery({
    queryKey: ["price-history", serviceId, model],
    queryFn: ({ signal }) =>
      read(
        rpc.pricing.history.$get(
          { query: { service_id: serviceId, model } },
          { init: { signal } },
        ),
      ),
    enabled,
  });
  if (history.isPending) return <Loading />;
  if (history.error) return <ErrorNotice error={history.error} />;
  return (
    <div className="space-y-3 pt-4">
      {history.data.items.length ? (
        history.data.items.map((item) => (
          <details key={item.id} className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Revision {item.revision}
              <span className="ml-3 text-xs font-normal text-muted-foreground">
                {date(item.created_at, timeZone)}
              </span>
            </summary>
            <div className="mt-4">
              <p className="mb-2 text-xs text-muted-foreground">
                Context window: {number(item.policy.context_window)} ·{" "}
                {item.policy.pricing?.currency ?? "Unpriced"} / million tokens
              </p>
              <DataTable
                data={item.policy.pricing?.tiers ?? []}
                columns={[
                  {
                    id: "bound",
                    header: "Up to",
                    cell: ({ row }) =>
                      row.original.up_to_input_tokens === null
                        ? "Unlimited"
                        : number(row.original.up_to_input_tokens),
                  },
                  ...(
                    [
                      ["input", "Input"],
                      ["output", "Output"],
                      ["cache_write", "Cache write"],
                      ["cache_read", "Cache read"],
                    ] as const
                  ).map(([key, title]) => ({
                    id: key,
                    header: title,
                    cell: ({ row }: { row: { original: PriceTier } }) =>
                      row.original[key],
                  })),
                ]}
                empty="No pricing in this revision"
              />
            </div>
          </details>
        ))
      ) : (
        <Empty title="No published prices yet">
          Save a model policy and publish the configuration to create the first
          price version.
        </Empty>
      )}
    </div>
  );
}
