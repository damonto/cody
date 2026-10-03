import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useProxyResources, type ProxyResources } from "@/lib/resources";
import { useClearProxyHealth, useProxyGroups } from "@/features/proxies/api";
import {
  DeleteProxyDialog,
  type ProxyDeletionTarget,
} from "@/features/proxies/delete-dialog";
import { ProxyGroupCard } from "@/features/proxies/group-card";
import { ProxyGroupEditor } from "@/features/proxies/group-editor";
import { ProxyNodeEditor } from "@/features/proxies/node-editor";
import { Empty, ErrorNotice, Loading, PageHeading } from "@/components/common";
import { Button } from "@/components/ui/button";

type ProxyDialog =
  | { kind: "create"; snapshot: ProxyResources }
  | { kind: "edit"; snapshot: ProxyResources; groupId: string }
  | {
      kind: "node";
      snapshot: ProxyResources;
      groupId: string;
      proxyId?: string;
    }
  | {
      kind: "delete";
      snapshot: ProxyResources;
      target: ProxyDeletionTarget;
    };

export default function Proxies() {
  const configuration = useProxyResources();
  const health = useProxyGroups(configuration.data?.version);
  const clear = useClearProxyHealth();
  const [dialog, setDialog] = useState<ProxyDialog | null>(null);

  if (configuration.isPending) {
    return <Loading />;
  }
  if (configuration.error) {
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  }

  const config = configuration.data;
  const liveGroups = new Map(
    health.data?.items.map((group) => [group.group_id, group]),
  );
  const closeDialog = (): void => setDialog(null);
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Proxies"
        description="Manage SOCKS5 groups and select them from providers or credentials."
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={health.isFetching}
            onClick={() => void health.refetch()}
          >
            <RefreshCw />
            Refresh
          </Button>
          <Button
            onClick={() =>
              setDialog({
                kind: "create",
                snapshot: structuredClone(configuration.data),
              })
            }
          >
            <Plus />
            Add group
          </Button>
        </div>
      </PageHeading>
      {health.error && (
        <ErrorNotice error={health.error} retry={() => void health.refetch()} />
      )}
      {clear.error && <ErrorNotice error={clear.error} />}
      {!config.groups.length && (
        <Empty title="Add your first proxy group">
          Create groups such as US or UK, then add SOCKS5 nodes.
        </Empty>
      )}
      {config.groups.map((group) => (
        <ProxyGroupCard
          key={group.id}
          group={group}
          version={configuration.data.version}
          live={liveGroups.get(group.id)}
          timeZone={config.reporting?.time_zone}
          clearing={clear.isPending}
          addNode={() =>
            setDialog({
              kind: "node",
              snapshot: structuredClone(configuration.data),
              groupId: group.id,
            })
          }
          edit={() =>
            setDialog({
              kind: "edit",
              snapshot: structuredClone(configuration.data),
              groupId: group.id,
            })
          }
          editNode={(proxyId) =>
            setDialog({
              kind: "node",
              snapshot: structuredClone(configuration.data),
              groupId: group.id,
              proxyId,
            })
          }
          remove={() =>
            setDialog({
              kind: "delete",
              snapshot: structuredClone(configuration.data),
              target: { kind: "group", groupId: group.id },
            })
          }
          removeNode={(proxyId) =>
            setDialog({
              kind: "delete",
              snapshot: structuredClone(configuration.data),
              target: { kind: "node", groupId: group.id, proxyId },
            })
          }
          clearHealth={(proxyId) =>
            clear.mutate({ groupId: group.id, proxyId })
          }
        />
      ))}
      {dialog?.kind === "delete" ? (
        <DeleteProxyDialog
          snapshot={dialog.snapshot}
          target={dialog.target}
          close={closeDialog}
        />
      ) : dialog?.kind === "node" ? (
        <ProxyNodeEditor
          key={JSON.stringify([dialog.groupId, dialog.proxyId ?? null])}
          snapshot={dialog.snapshot}
          groupId={dialog.groupId}
          {...(dialog.proxyId === undefined ? {} : { proxyId: dialog.proxyId })}
          close={closeDialog}
        />
      ) : (
        dialog && (
          <ProxyGroupEditor
            key={dialog.kind === "edit" ? `edit:${dialog.groupId}` : "create"}
            snapshot={dialog.snapshot}
            {...(dialog.kind === "edit" ? { groupId: dialog.groupId } : {})}
            close={closeDialog}
          />
        )
      )}
    </>
  );
}
