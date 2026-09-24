import { useState } from "react";
import { Plus } from "lucide-react";
import { useDraft, type Draft } from "@/lib/api";
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
  | { kind: "create"; snapshot: Draft }
  | { kind: "edit"; snapshot: Draft; groupId: string }
  | { kind: "node"; snapshot: Draft; groupId: string; proxyId?: string }
  | { kind: "delete"; snapshot: Draft; target: ProxyDeletionTarget };

export default function Proxies() {
  const draft = useDraft();
  const health = useProxyGroups(draft.data?.published_revision);
  const clear = useClearProxyHealth();
  const [dialog, setDialog] = useState<ProxyDialog | null>(null);

  if (draft.isPending) {
    return <Loading />;
  }
  if (draft.error) {
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  }

  const config = draft.data.config;
  const liveGroups = new Map(
    health.data?.items.map((group) => [group.group_id, group]),
  );
  const closeDialog = (): void => setDialog(null);
  return (
    <>
      <PageHeading
        title="Proxies"
        description="Manage SOCKS5 groups and select them from providers or credentials."
      >
        <Button
          onClick={() =>
            setDialog({ kind: "create", snapshot: structuredClone(draft.data) })
          }
        >
          <Plus />
          Add group
        </Button>
      </PageHeading>
      <p className="text-sm text-muted-foreground">
        Group edits take effect after publishing. Live health and fixed bindings
        reflect the published configuration. Three connection failures within
        one minute cool a node for five minutes.
      </p>
      <p className="text-sm text-muted-foreground">
        Test checks the saved draft node’s exit IP without changing live health.
        Results are cleared when you change the draft or leave this page.
      </p>
      {health.error && (
        <ErrorNotice error={health.error} retry={() => void health.refetch()} />
      )}
      {clear.error && <ErrorNotice error={clear.error} />}
      {!config.proxy_groups.length && (
        <Empty title="Add your first proxy group">
          Create groups such as US or UK, then add SOCKS5 nodes.
        </Empty>
      )}
      {config.proxy_groups.map((group) => (
        <ProxyGroupCard
          key={group.id}
          group={group}
          version={draft.data.version}
          live={liveGroups.get(group.id)}
          timeZone={config.reporting?.time_zone}
          clearing={clear.isPending}
          addNode={() =>
            setDialog({
              kind: "node",
              snapshot: structuredClone(draft.data),
              groupId: group.id,
            })
          }
          edit={() =>
            setDialog({
              kind: "edit",
              snapshot: structuredClone(draft.data),
              groupId: group.id,
            })
          }
          editNode={(proxyId) =>
            setDialog({
              kind: "node",
              snapshot: structuredClone(draft.data),
              groupId: group.id,
              proxyId,
            })
          }
          remove={() =>
            setDialog({
              kind: "delete",
              snapshot: structuredClone(draft.data),
              target: { kind: "group", groupId: group.id },
            })
          }
          removeNode={(proxyId) =>
            setDialog({
              kind: "delete",
              snapshot: structuredClone(draft.data),
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
