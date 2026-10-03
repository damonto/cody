import { useDeleteProxy } from "./mutations";
import { ApiError } from "@/lib/api";
import { type ProxyResources } from "@/lib/resources";
import { ErrorNotice } from "@/components/common";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ProxyDeletionTarget =
  | { readonly kind: "group"; readonly groupId: string }
  | {
      readonly kind: "node";
      readonly groupId: string;
      readonly proxyId: string;
    };

interface DeleteProxyDialogProps {
  readonly snapshot: ProxyResources;
  readonly target: ProxyDeletionTarget;
  readonly close: () => void;
}

export function DeleteProxyDialog({
  snapshot,
  target,
  close,
}: DeleteProxyDialogProps) {
  const save = useDeleteProxy();
  const group = snapshot.groups.find((item) => item.id === target.groupId);
  const groupName = group?.name ?? target.groupId;
  const nodeName =
    target.kind === "node"
      ? (group?.proxies.find((node) => node.id === target.proxyId)?.name ??
        target.proxyId)
      : undefined;
  const referencedBy =
    target.kind === "group"
      ? snapshot.providers.flatMap((provider) => [
          ...(provider.proxy_group === target.groupId
            ? [provider.name ?? provider.id]
            : []),
          ...provider.credentials
            .filter((credential) => credential.proxy_group === target.groupId)
            .map(
              (credential) =>
                `${provider.name ?? provider.id} / ${credential.name ?? credential.id}`,
            ),
        ])
      : [];

  const remove = (): void => {
    save.mutate(
      {
        version: snapshot.version,
        groupId: target.groupId,
        nodeId: target.kind === "node" ? target.proxyId : null,
      },
      { onSuccess: close },
    );
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target.kind === "group"
              ? `Remove group ${groupName}?`
              : `Remove proxy ${nodeName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target.kind === "group"
              ? "The group and its nodes will be removed from the configuration."
              : `This node will be removed from group ${groupName} in the configuration.`}{" "}
            {referencedBy.length
              ? `Update references from ${referencedBy.join(", ")} before saving.`
              : "Saving applies immediately to new requests."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {save.error && <ErrorNotice error={save.error} />}
        {save.error instanceof ApiError && save.error.status === 409 && (
          <p className="text-sm text-muted-foreground">
            Refresh this page to load the latest configuration before trying
            again.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={save.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={save.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove();
            }}
          >
            Remove from configuration
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
