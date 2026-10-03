import { useSaveProxyNode } from "./mutations";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { type ProxyResources } from "@/lib/resources";
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
  readonly snapshot: ProxyResources;
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
  const save = useSaveProxyNode();
  const group = snapshot.groups.find((entry) => entry.id === groupId);
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
      try {
        await save.mutateAsync({
          version: snapshot.version,
          groupId,
          id: proxyId ?? null,
          node,
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
                Saving applies this proxy configuration immediately.
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
                <ProxyNodeInputs form={form} fields="node" />
              </fieldset>
              {save.error && <ErrorNotice error={save.error} />}
              {save.error instanceof ApiError && save.error.status === 409 && (
                <p className="text-sm text-muted-foreground">
                  Refresh this page to load the latest configuration before
                  trying again.
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
