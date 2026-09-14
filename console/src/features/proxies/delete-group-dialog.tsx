import { useSaveDraft, type Draft } from "@/lib/api";
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

interface DeleteProxyGroupDialogProps {
  readonly snapshot: Draft;
  readonly groupId: string;
  readonly close: () => void;
}

export function DeleteProxyGroupDialog({
  snapshot,
  groupId,
  close,
}: DeleteProxyGroupDialogProps) {
  const save = useSaveDraft();
  const referencedBy = snapshot.config.providers.flatMap((provider) => [
    ...(provider.proxy_group === groupId ? [provider.id] : []),
    ...provider.credentials
      .filter((credential) => credential.proxy_group === groupId)
      .map((credential) => `${provider.id} / ${credential.id}`),
  ]);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove group {groupId}?</AlertDialogTitle>
          <AlertDialogDescription>
            The group and its nodes will be removed from the draft.{" "}
            {referencedBy.length
              ? `Update references from ${referencedBy.join(", ")} before publishing.`
              : "Published traffic changes when you publish the draft."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {save.error && <ErrorNotice error={save.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={save.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={save.isPending}
            onClick={(event) => {
              event.preventDefault();
              save.mutate(
                {
                  version: snapshot.version,
                  config: {
                    ...snapshot.config,
                    proxy_groups: snapshot.config.proxy_groups.filter(
                      (group) => group.id !== groupId,
                    ),
                  },
                },
                { onSuccess: close },
              );
            }}
          >
            Remove from draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
