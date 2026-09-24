import { useState } from "react";
import { ApiError, useSaveDraft, type Draft } from "@/lib/api";
import { useAppForm } from "@/lib/form";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  proxyNodeFormOptions,
  proxyNodeEditorSchema,
  newProxyNode,
} from "./form-options";
import { ProxyNodeInputs } from "./node-inputs";

interface ProxyNodeEditorProps {
  readonly snapshot: Draft;
  readonly groupId: string;
  readonly proxyId?: string;
  readonly close: () => void;
}

export function ProxyNodeEditor({
  snapshot,
  groupId,
  proxyId,
  close,
}: ProxyNodeEditorProps) {
  const save = useSaveDraft();
  const group = snapshot.config.proxy_groups.find(
    (entry) => entry.id === groupId,
  );
  if (!group)
    throw new Error("Proxy group is missing from the editing snapshot");
  const [initial] = useState(() => {
    if (proxyId !== undefined) {
      const node = group.proxies.find((entry) => entry.id === proxyId);
      if (!node)
        throw new Error("Proxy node is missing from the editing snapshot");
      return { node: structuredClone(node) };
    }
    const { rowId: _rowId, ...node } = newProxyNode();
    return { node };
  });
  const form = useAppForm({
    ...proxyNodeFormOptions,
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const { node } = proxyNodeEditorSchema.parse(value);
      if (
        group.proxies.some(
          (entry) => entry.id !== proxyId && entry.id === node.id,
        )
      ) {
        form.setFieldMeta("node.id", (meta) => ({
          ...meta,
          errorMap: {
            onSubmit: "A proxy with this ID already exists in this group",
          },
        }));
        return;
      }
      try {
        await save.mutateAsync({
          version: snapshot.version,
          config: {
            ...snapshot.config,
            proxy_groups: snapshot.config.proxy_groups.map((entry) =>
              entry.id === groupId
                ? {
                    ...entry,
                    proxies:
                      proxyId === undefined
                        ? [...entry.proxies, node]
                        : entry.proxies.map((existing) =>
                            existing.id === proxyId ? node : existing,
                          ),
                  }
                : entry,
            ),
          },
        });
        close();
      } catch {
        // Keep entered values and the version guard intact for a retry.
      }
    },
  });
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(submitting) => (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !submitting) close();
          }}
        >
          <DialogContent
            className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
            showCloseButton={!submitting}
          >
            <DialogHeader>
              <DialogTitle>
                {proxyId === undefined
                  ? `Add proxy to ${groupId}`
                  : `Edit proxy ${proxyId}`}
              </DialogTitle>
              <DialogDescription>
                Save this node to group {groupId} in your draft, then publish
                when ready.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <fieldset disabled={submitting}>
                <ProxyNodeInputs
                  form={form}
                  fields="node"
                  readOnlyId={proxyId !== undefined}
                />
              </fieldset>
              {save.error && <ErrorNotice error={save.error} />}
              {save.error instanceof ApiError && save.error.status === 409 && (
                <p className="text-sm text-muted-foreground">
                  Refresh this page to load the latest draft before trying
                  again.
                </p>
              )}
              <form.AppForm>
                <form.Errors />
              </form.AppForm>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {proxyId === undefined ? "Add proxy" : "Save proxy"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </form.Subscribe>
  );
}
