import { Plus, Trash2 } from "lucide-react";
import type { ProxyGroupConfig } from "../../../../src/config/types";
import type { ProxyGroupStatus } from "../../../../src/gateway/proxies/schema";
import { date } from "@/lib/format";
import { DataTable } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProxyNodeRow } from "./node-row";

interface ProxyGroupCardProps {
  readonly group: ProxyGroupConfig;
  readonly version: number;
  readonly live: ProxyGroupStatus | undefined;
  readonly timeZone: string | undefined;
  readonly clearing: boolean;
  readonly edit: () => void;
  readonly addNode: () => void;
  readonly editNode: (proxyId: string) => void;
  readonly remove: () => void;
  readonly removeNode: (proxyId: string) => void;
  readonly clearHealth: (proxyId: string) => void;
}

export function ProxyGroupCard({
  group,
  version,
  live,
  timeZone,
  clearing,
  edit,
  addNode,
  editNode,
  remove,
  removeNode,
  clearHealth,
}: ProxyGroupCardProps) {
  const healthById = new Map(live?.proxies.map((node) => [node.id, node]));
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CardTitle>{group.id}</CardTitle>
          <Badge variant="secondary">{group.strategy}</Badge>
        </div>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Add proxy to ${group.id}`}
            onClick={addNode}
          >
            <Plus />
            Add proxy
          </Button>
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
        {!group.proxies.length ? (
          <p className="text-sm text-muted-foreground">
            This group has no nodes. Requests selecting it will be unavailable.
          </p>
        ) : (
          <Table>
            <TableHeader className="[&_th]:h-11 [&_th]:bg-muted/30 [&_th]:text-xs">
              <TableRow>
                {["Proxy", "Priority", "Draft", "Live health", "Exit IP"].map(
                  (heading) => (
                    <TableHead key={heading} scope="col">
                      {heading}
                    </TableHead>
                  ),
                )}
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.proxies.map((node) => (
                <ProxyNodeRow
                  key={JSON.stringify([version, node.id])}
                  groupId={group.id}
                  version={version}
                  node={node}
                  health={healthById.get(node.id)}
                  timeZone={timeZone}
                  clearing={clearing}
                  edit={editNode}
                  remove={removeNode}
                  clearHealth={clearHealth}
                />
              ))}
            </TableBody>
          </Table>
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
