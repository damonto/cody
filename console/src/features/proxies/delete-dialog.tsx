import { ApiError, useSaveDraft, type Draft } from "@/lib/api";
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
  readonly snapshot: Draft;
  readonly target: ProxyDeletionTarget;
  readonly close: () => void;
}

export function DeleteProxyDialog({
  snapshot,
  target,
  close,
}: DeleteProxyDialogProps) {
  const save = useSaveDraft();
  const referencedBy =
    target.kind === "group"
      ? snapshot.config.providers.flatMap((provider) => [
          ...(provider.proxy_group === target.groupId ? [provider.id] : []),
          ...provider.credentials
            .filter((credential) => credential.proxy_group === target.groupId)
            .map((credential) => `${provider.id} / ${credential.id}`),
        ])
      : [];

  const remove = (): void => {
    const groups = snapshot.config.proxy_groups;
    const proxy_groups =
      target.kind === "group"
        ? groups.filter((group) => group.id !== target.groupId)
        : groups.map((group) =>
            group.id === target.groupId
              ? {
                  ...group,
                  proxies: group.proxies.filter(
                    (node) => node.id !== target.proxyId,
                  ),
                }
              : group,
          );
    save.mutate(
      {
        version: snapshot.version,
        config: { ...snapshot.config, proxy_groups },
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
              ? `Remove group ${target.groupId}?`
              : `Remove proxy ${target.proxyId}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target.kind === "group"
              ? "The group and its nodes will be removed from the draft."
              : `This node will be removed from group ${target.groupId} in the draft.`}{" "}
            {referencedBy.length
              ? `Update references from ${referencedBy.join(", ")} before publishing.`
              : "Published traffic changes when you publish the draft."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {save.error && <ErrorNotice error={save.error} />}
        {save.error instanceof ApiError && save.error.status === 409 && (
          <p className="text-sm text-muted-foreground">
            Refresh this page to load the latest draft before trying again.
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
            Remove from draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
