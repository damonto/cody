import { ProviderType } from "../../../src/config/values.ts";

import { useState } from "react";
import { Settings2 } from "lucide-react";
import type { XaiProviderConfig } from "../../../src/config/types";
import { useDraft, useSaveDraft, type Draft } from "@/lib/api";
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
import { XaiAccounts } from "@/features/xai/accounts";
import { AccountForm } from "@/features/xai/account-form";
import { XaiSettingsForm } from "@/features/xai/settings-form";
import {
  xaiProvider,
  moveAccount,
  setAccountDisabled,
} from "@/features/xai/form-options";
import { updateProvider } from "@/features/providers/mutations";

type EditorAction =
  | { kind: "settings" }
  | { kind: "account"; credentialId?: string }
  | { kind: "remove"; credentialId: string };
type Editor = { snapshot: Draft } & EditorAction;

export default function Xai() {
  const draft = useDraft();
  const save = useSaveDraft();
  const [editor, setEditor] = useState<Editor | null>(null);
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const provider = xaiProvider(draft.data.config);
  const editingProvider = editor
    ? xaiProvider(editor.snapshot.config)
    : provider;
  const open = (action: EditorAction) => {
    save.reset();
    setEditor({ ...action, snapshot: structuredClone(draft.data) });
  };
  const persist = async (snapshot: Draft, next: XaiProviderConfig) => {
    await save.mutateAsync({
      config: updateProvider(
        snapshot.config,
        snapshot.config.providers.findIndex(
          (entry) => entry.type === ProviderType.Xai,
        ),
        next,
      ),
      version: snapshot.version,
    });
  };
  const saveEditor = async (next: XaiProviderConfig) => {
    if (!editor) return;
    await persist(editor.snapshot, next);
    setEditor(null);
  };
  const close = () => {
    if (!save.isPending) setEditor(null);
  };
  const failedSave = save.variables;
  return (
    <>
      <PageHeading
        title="xAI"
        description="xAI accounts and subscription quotas."
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
      {!editor && save.error && (
        <ErrorNotice
          error={save.error}
          retry={failedSave ? () => save.mutate(failedSave) : undefined}
        />
      )}
      <XaiAccounts
        provider={provider}
        pending={save.isPending}
        onAdd={() => open({ kind: "account" })}
        onConfigure={(credentialId) => open({ kind: "account", credentialId })}
        onRemove={(credentialId) => open({ kind: "remove", credentialId })}
        onMove={(id, direction) => {
          void persist(draft.data, moveAccount(provider, id, direction)).catch(
            () => {},
          );
        }}
        onToggle={(id, disabled) => {
          void persist(
            draft.data,
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
                ? "xAI settings"
                : editor?.kind === "account" && editor.credentialId
                  ? "Manage xAI account"
                  : "Add xAI account"}
            </DialogTitle>
            <DialogDescription>
              Save changes to the draft, then publish when ready.
            </DialogDescription>
          </DialogHeader>
          {editor?.kind === "settings" && (
            <XaiSettingsForm
              provider={editingProvider}
              groups={editor.snapshot.config.proxy_groups}
              pending={save.isPending}
              onSave={saveEditor}
              close={close}
            />
          )}
          {editor?.kind === "account" && (
            <AccountForm
              provider={editingProvider}
              credentialId={editor.credentialId}
              groups={editor.snapshot.config.proxy_groups}
              version={editor.snapshot.version}
              draftVersion={draft.data.version}
              pending={save.isPending}
              onSave={saveEditor}
              close={close}
            />
          )}
          {editor && editor.snapshot.version !== draft.data.version && (
            <p role="alert" className="text-sm text-destructive">
              The draft changed. Your edits are retained; reopen from the latest
              draft before saving.
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
            <AlertDialogTitle>Remove this xAI account?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its draft reference. xAI authorization is kept.
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
                  credentials: editingProvider.credentials.filter(
                    (credential) => credential.id !== editor.credentialId,
                  ),
                }).catch(() => {});
              }}
            >
              Remove from draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
