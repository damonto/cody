import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import type { ClaudeProviderConfig } from "../../../src/config/types";
import { useNativeResources, type NativeResources } from "@/lib/resources";
import { ErrorNotice, Loading, PageHeading, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { ClaudeAccounts } from "@/features/claude/accounts";
import { AccountForm } from "@/features/claude/account-form";
import { ClaudeSettingsForm } from "@/features/claude/settings-form";
import {
  claudeProvider,
  moveAccount,
  setAccountDisabled,
} from "@/features/claude/form-options";
import { useNativeProviderMutation } from "@/features/providers/api";

type EditorAction =
  | { kind: "settings" }
  | { kind: "account"; credentialId?: string }
  | { kind: "remove"; credentialId: string };
type Editor = { snapshot: NativeResources } & EditorAction;

export default function Claude() {
  const configuration = useNativeResources("claude");
  const save = useNativeProviderMutation("claude");
  const [editor, setEditor] = useState<Editor | null>(null);
  if (configuration.isPending) return <Loading />;
  if (configuration.error)
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  const provider = claudeProvider(configuration.data.provider);
  const editingProvider = editor
    ? claudeProvider(editor.snapshot.provider)
    : provider;
  const open = (action: EditorAction) => {
    save.reset();
    setEditor({ ...action, snapshot: structuredClone(configuration.data) });
  };
  const persistOrder = async (
    snapshot: NativeResources,
    next: ClaudeProviderConfig,
  ) => {
    await save.mutateAsync({
      action: "reorder-credentials",
      providerId: next.id,
      ids: next.credentials.map((credential) => credential.id),
      version: snapshot.version,
    });
  };
  const saveEditor = async (next: ClaudeProviderConfig) => {
    if (!editor) return;
    const version = editor.snapshot.version;
    if (editor.kind === "settings")
      await save.mutateAsync({ action: "settings", provider: next, version });
    else if (editor.kind === "remove")
      await save.mutateAsync({
        action: "delete-credential",
        providerId: next.id,
        credentialId: editor.credentialId,
        version,
      });
    else {
      const credential = editor.credentialId
        ? next.credentials.find((item) => item.id === editor.credentialId)
        : next.credentials.find(
            (item) =>
              !editingProvider.credentials.some((old) => old.id === item.id),
          );
      if (!credential) throw new Error("Credential is missing from the editor");
      await save.mutateAsync({
        action: editor.credentialId ? "update-credential" : "create-credential",
        providerId: next.id,
        credential,
        version,
      });
    }
    setEditor(null);
  };
  const close = () => {
    if (!save.isPending) setEditor(null);
  };
  const failedSave = save.variables;
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Claude"
        description="Claude accounts and subscription quotas."
        badge={<Status value={provider.disabled ? "disabled" : "enabled"} />}
      >
        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => open({ kind: "settings" })}
        >
          <Settings2 />
          Settings
        </Button>
      </PageHeading>
      {!configuration.data.provider && (
        <p className="text-sm text-muted-foreground">
          Save provider settings before adding accounts.
        </p>
      )}
      {!editor && save.error && (
        <ErrorNotice
          error={save.error}
          retry={failedSave ? () => save.mutate(failedSave) : undefined}
        />
      )}
      <ClaudeAccounts
        provider={provider}
        pending={save.isPending || !configuration.data.provider}
        onAdd={() => open({ kind: "account" })}
        onConfigure={(credentialId) => open({ kind: "account", credentialId })}
        onRemove={(credentialId) => open({ kind: "remove", credentialId })}
        onMove={(id, direction) => {
          void persistOrder(
            configuration.data,
            moveAccount(provider, id, direction),
          ).catch(() => {});
        }}
        onToggle={(id, disabled) => {
          void persistOrder(
            configuration.data,
            setAccountDisabled(provider, id, disabled),
          ).catch(() => {});
        }}
      />
      <Dialog
        open={!!editor && editor.kind !== "remove"}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === "settings"
                ? "Claude settings"
                : editor?.kind === "account" && editor.credentialId
                  ? "Manage Claude account"
                  : "Add Claude account"}
            </DialogTitle>
            <DialogDescription>
              Saved changes apply to new requests immediately.
            </DialogDescription>
          </DialogHeader>
          {editor?.kind === "settings" && (
            <ClaudeSettingsForm
              provider={editingProvider}
              groups={editor.snapshot.groups}
              pending={save.isPending}
              onSave={saveEditor}
              close={close}
            />
          )}
          {editor?.kind === "account" && (
            <AccountForm
              provider={editingProvider}
              credentialId={editor.credentialId}
              groups={editor.snapshot.groups}
              version={editor.snapshot.version}
              configurationVersion={configuration.data.version}
              pending={save.isPending || !configuration.data.provider}
              onSave={saveEditor}
              close={close}
            />
          )}
          {editor && editor.snapshot.version !== configuration.data.version && (
            <p role="alert" className="text-sm text-destructive">
              The configuration changed. Your edits are retained; reopen from
              the latest configuration before saving.
            </p>
          )}
          {save.error && <ErrorNotice error={save.error} />}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={editor?.kind === "remove"}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this Claude account?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its saved reference. Claude authorization is kept.
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
                if (editor?.kind !== "remove") return;
                void saveEditor({
                  ...editingProvider,
                  disabled:
                    editingProvider.disabled ||
                    editingProvider.credentials.length === 1,
                  credentials: editingProvider.credentials.filter(
                    (credential) => credential.id !== editor.credentialId,
                  ),
                }).catch(() => {});
              }}
            >
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
