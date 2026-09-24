import { LoaderCircle, Pencil, Play, RotateCcw, Trash2 } from "lucide-react";
import type { ProxyNodeConfig } from "../../../../src/config/types";
import type { ProxyGroupStatus } from "../../../../src/gateway/proxies/schema";
import { date } from "@/lib/format";
import { Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { useProxyTest, type ProxyTestState } from "./use-proxy-test";

interface ProxyNodeRowProps {
  readonly groupId: string;
  readonly version: number;
  readonly node: Pick<ProxyNodeConfig, "id" | "url" | "priority" | "disabled">;
  readonly health: ProxyGroupStatus["proxies"][number] | undefined;
  readonly timeZone: string | undefined;
  readonly clearing: boolean;
  readonly edit: (proxyId: string) => void;
  readonly remove: (proxyId: string) => void;
  readonly clearHealth: (proxyId: string) => void;
}

function NodeExitIp({ state }: { readonly state: ProxyTestState | undefined }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  if (state.status === "pending") return <span role="status">Testing…</span>;
  if (state.status === "error") {
    return (
      <p role="alert" className="break-words text-sm text-destructive">
        {state.message}
      </p>
    );
  }
  const { ip, country } = state.result;
  const flag = country
    ? String.fromCodePoint(
        ...Array.from(country, (letter) => 127397 + letter.charCodeAt(0)),
      )
    : "🌐";
  return (
    <span className="flex items-start gap-2">
      <span
        className="shrink-0"
        role="img"
        aria-label={country ?? "Unknown country"}
      >
        {flag}
      </span>
      <span className="min-w-0 break-all font-mono text-sm">{ip}</span>
    </span>
  );
}

export function ProxyNodeRow({
  groupId,
  version,
  node,
  health,
  timeZone,
  clearing,
  edit,
  remove,
  clearHealth,
}: ProxyNodeRowProps) {
  const { state, test } = useProxyTest(groupId, node.id, version);
  const testing = state?.status === "pending";
  return (
    <TableRow className="[&_td]:h-14">
      <TableCell>
        <p className="font-medium">{node.id}</p>
        <p className="text-xs text-muted-foreground">{node.url}</p>
      </TableCell>
      <TableCell>{node.priority}</TableCell>
      <TableCell>
        <Status value={node.disabled ? "disabled" : "enabled"} />
      </TableCell>
      <TableCell>
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
      </TableCell>
      <TableCell>
        <div className="w-64 whitespace-normal">
          <NodeExitIp state={state} />
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Test"
            title="Test"
            disabled={testing}
            onClick={() => void test()}
          >
            {testing ? <LoaderCircle className="animate-spin" /> : <Play />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear health"
            title="Clear health"
            disabled={
              clearing || !health || (!health.failures && !health.cooling_until)
            }
            onClick={() => clearHealth(node.id)}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit proxy ${node.id} in ${groupId}`}
            title="Edit proxy"
            onClick={() => edit(node.id)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete proxy ${node.id} from ${groupId}`}
            title="Delete proxy"
            onClick={() => remove(node.id)}
          >
            <Trash2 />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
