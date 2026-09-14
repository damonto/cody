import { Trash2 } from "lucide-react";
import type { ProxyGroupConfig } from "../../../../src/config/types";
import type { ProxyGroupStatus } from "../../../../src/gateway/proxies/schema";
import { date } from "@/lib/format";
import { DataTable, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ProxyGroupCardProps {
  readonly group: ProxyGroupConfig;
  readonly live: ProxyGroupStatus | undefined;
  readonly timeZone: string | undefined;
  readonly clearing: boolean;
  readonly edit: () => void;
  readonly remove: () => void;
  readonly clearHealth: (proxyId: string) => void;
}

function NodeHealth({
  health,
  timeZone,
}: {
  readonly health: ProxyGroupStatus["proxies"][number] | undefined;
  readonly timeZone: string | undefined;
}) {
  return (
    <div>
      <Status value={health?.status ?? "unpublished"} />
      {health?.cooling_until && (
        <p className="mt-1 text-xs text-muted-foreground">
          Until {date(health.cooling_until, timeZone)}
        </p>
      )}
      {health && (
        <p className="text-xs text-muted-foreground">
          {health.failures} failures
        </p>
      )}
    </div>
  );
}

export function ProxyGroupCard({
  group,
  live,
  timeZone,
  clearing,
  edit,
  remove,
  clearHealth,
}: ProxyGroupCardProps) {
  const healthById = new Map(live?.proxies.map((node) => [node.id, node]));
  const nodes = group.proxies.map(({ id, url, priority, disabled }) => ({
    id,
    url,
    priority,
    disabled,
    health: healthById.get(id),
  }));
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CardTitle>{group.id}</CardTitle>
          <Badge variant="secondary">{group.strategy}</Badge>
        </div>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={edit}>
            Configure {group.id}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete group ${group.id}`}
            onClick={remove}
          >
            <Trash2 />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!nodes.length ? (
          <p className="text-sm text-muted-foreground">
            This group has no nodes. Requests selecting it will be unavailable.
          </p>
        ) : (
          <DataTable
            data={nodes}
            columns={[
              {
                id: "id",
                header: "Proxy",
                cell: ({ row }) => (
                  <div>
                    <p className="font-medium">{row.original.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.original.url}
                    </p>
                  </div>
                ),
              },
              {
                id: "priority",
                header: "Priority",
                cell: ({ row }) => row.original.priority,
              },
              {
                id: "enabled",
                header: "Draft",
                cell: ({ row }) => (
                  <Status
                    value={row.original.disabled ? "disabled" : "enabled"}
                  />
                ),
              },
              {
                id: "health",
                header: "Live health",
                cell: ({ row }) => (
                  <NodeHealth
                    health={row.original.health}
                    timeZone={timeZone}
                  />
                ),
              },
              {
                id: "clear",
                header: "",
                cell: ({ row }) => (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      clearing ||
                      !row.original.health ||
                      (!row.original.health.failures &&
                        !row.original.health.cooling_until)
                    }
                    onClick={() => clearHealth(row.original.id)}
                  >
                    Clear health
                  </Button>
                ),
              },
            ]}
          />
        )}
        {!!live?.bindings.length && (
          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">Fixed bindings</h3>
            <DataTable
              data={live.bindings}
              columns={[
                {
                  id: "owner",
                  header: "Provider / credential",
                  cell: ({ row }) =>
                    `${row.original.provider_id}${row.original.credential_id ? ` / ${row.original.credential_id}` : " / inherited credentials"}`,
                },
                {
                  id: "proxy",
                  header: "Proxy",
                  cell: ({ row }) => row.original.proxy_id,
                },
                {
                  id: "created",
                  header: "Assigned",
                  cell: ({ row }) => date(row.original.created_at, timeZone),
                },
              ]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
