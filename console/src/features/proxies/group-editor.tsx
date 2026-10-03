import { useSaveProxyGroup } from "./mutations";
import { ProxyStrategy } from "../../../../src/config/values.ts";

import { useId, useState } from "react";
import { proxyStrategySchema } from "../../../../src/config/schema";
import { useAppForm } from "@/lib/form";
import { type ProxyResources } from "@/lib/resources";
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
  readonly snapshot: ProxyResources;
  readonly groupId?: string;
  readonly close: () => void;
}

export function ProxyGroupEditor({
  snapshot,
  groupId,
  close,
}: ProxyGroupEditorProps) {
  const save = useSaveProxyGroup();
  const strategyId = useId();
  // This is an editing snapshot: background configuration refreshes must not replace unsaved input.
  const [initial] = useState(() => {
    const group = snapshot.groups.find((entry) => entry.id === groupId);
    if (groupId !== undefined && !group) {
      throw new Error("Proxy group is missing from the editing snapshot");
    }
    return proxyGroupFormValues(group);
  });
  const form = useAppForm({
    ...proxyGroupFormOptions,
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const group = proxyGroupEditorSchema.parse(value);
      try {
        await save.mutateAsync({
          group,
          id: groupId ?? null,
          version: snapshot.version,
        });
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
                Saving applies these changes immediately.
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
                <form.AppField name="name">
                  {(field) => (
                    <field.TextField
                      label="Group name"
                      placeholder="US"
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
                          <SelectItem value={ProxyStrategy.Random}>
                            Random
                          </SelectItem>
                          <SelectItem value={ProxyStrategy.Sticky}>
                            Fixed per provider / credential
                          </SelectItem>
                          <SelectItem value={ProxyStrategy.Priority}>
                            Priority
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {field.state.value === ProxyStrategy.Random
                          ? "Choose any healthy node at random, ignoring Priority."
                          : field.state.value === ProxyStrategy.Sticky
                            ? "Randomly assign a healthy node and keep it until it becomes unavailable."
                            : "Choose the highest Priority among healthy nodes; break ties randomly."}
                      </FieldDescription>
                      <FieldError errors={fieldErrors(field)} />
                    </Field>
                  )}
                </form.AppField>
                <ProxyNodeFields form={form} />
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
