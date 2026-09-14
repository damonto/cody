import { useId, useState } from "react";
import { proxyStrategySchema } from "../../../../src/config/schema";
import { useAppForm } from "@/lib/form";
import { useSaveDraft, type Draft } from "@/lib/api";
import { fieldErrors } from "@/lib/form-errors";
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
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  proxyGroupEditorSchema,
  proxyGroupFormOptions,
  proxyGroupFormValues,
} from "./form-options";
import { ProxyNodeFields } from "./node-fields";

interface ProxyGroupEditorProps {
  readonly snapshot: Draft;
  readonly groupId?: string;
  readonly close: () => void;
}

export function ProxyGroupEditor({
  snapshot,
  groupId,
  close,
}: ProxyGroupEditorProps) {
  const save = useSaveDraft();
  const strategyId = useId();
  // This is an editing snapshot: background draft refreshes must not replace unsaved input.
  const [initial] = useState(() => {
    const group = snapshot.config.proxy_groups.find(
      (entry) => entry.id === groupId,
    );
    if (groupId !== undefined && !group) {
      throw new Error("Proxy group is missing from the editing snapshot");
    }
    return proxyGroupFormValues(group);
  });
  const form = useAppForm({
    ...proxyGroupFormOptions,
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      if (
        snapshot.config.proxy_groups.some(
          (group) => group.id !== groupId && group.id === value.id,
        )
      ) {
        form.setFieldMeta("id", (meta) => ({
          ...meta,
          errorMap: { onSubmit: "A group with this ID already exists" },
        }));
        return;
      }
      const group = proxyGroupEditorSchema.parse(value);
      const config = {
        ...snapshot.config,
        proxy_groups:
          groupId === undefined
            ? [...snapshot.config.proxy_groups, group]
            : snapshot.config.proxy_groups.map((entry) =>
                entry.id === groupId ? group : entry,
              ),
      };
      try {
        await save.mutateAsync({ config, version: snapshot.version });
        close();
      } catch {
        // Keep the editing snapshot and error visible; retry uses the same version guard.
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
            className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
            showCloseButton={!submitting}
          >
            <DialogHeader>
              <DialogTitle>
                {groupId === undefined
                  ? "Add proxy group"
                  : "Configure proxy group"}
              </DialogTitle>
              <DialogDescription>
                Save changes to your draft, then publish when ready.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <fieldset disabled={submitting} className="space-y-5">
                <form.AppField name="id">
                  {(field) => (
                    <field.TextField
                      label="Group ID"
                      placeholder="US"
                      readOnly={groupId !== undefined}
                      hint="Stable identifier selected by providers and credentials."
                    />
                  )}
                </form.AppField>
                <form.AppField name="strategy">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={strategyId}>
                        Selection strategy
                      </FieldLabel>
                      <Select
                        value={field.state.value}
                        onValueChange={(value) =>
                          field.handleChange(proxyStrategySchema.parse(value))
                        }
                      >
                        <SelectTrigger
                          id={strategyId}
                          className="w-full"
                          onBlur={field.handleBlur}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="random">Random</SelectItem>
                          <SelectItem value="sticky">
                            Fixed per provider / credential
                          </SelectItem>
                          <SelectItem value="priority">Priority</SelectItem>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {field.state.value === "random"
                          ? "Choose any healthy node at random, ignoring Priority."
                          : field.state.value === "sticky"
                            ? "Randomly assign a healthy node and keep it until it becomes unavailable."
                            : "Choose the highest Priority among healthy nodes; break ties randomly."}
                      </FieldDescription>
                      <FieldError errors={fieldErrors(field)} />
                    </Field>
                  )}
                </form.AppField>
                <ProxyNodeFields
                  form={form}
                  savedRowIds={initial.proxies.map((node) => node.rowId)}
                />
              </fieldset>
              {save.error && <ErrorNotice error={save.error} />}
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
                  Save group
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </form.Subscribe>
  );
}
