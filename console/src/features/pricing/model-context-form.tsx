import { useResourceEditor } from "@/lib/use-resource-editor";
import { ResourceConflict } from "@/components/form/resource-conflict";
import { z } from "zod";
import { useAppForm } from "@/lib/form";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/common";
import { useSaveModelSettings } from "@/features/providers/api";
const schema = z.object({
  context_window: z.number().int().positive().optional(),
});
export function ModelContextForm({
  version,
  providerId,
  modelId,
  contextWindows,
  family,
}: {
  version: number;
  providerId: string;
  modelId: string;
  contextWindows: readonly (number | undefined)[];
  family: boolean;
}) {
  const save = useSaveModelSettings();
  const contextWindow = contextWindows.every(
    (value) => value === contextWindows[0],
  )
    ? contextWindows[0]
    : undefined;
  const etag = family ? JSON.stringify(contextWindows) : undefined;
  const editor = useResourceEditor({ version, item: contextWindow, etag });
  const initial: z.input<typeof schema> = { context_window: editor.initial };
  const form = useAppForm({
    defaultValues: initial,
    validators: { onBlur: schema, onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = await save.mutateAsync({
          version: editor.version,
          providerId,
          modelId,
          family,
          context_window: value.context_window ?? null,
        });
        const settings = schema.parse(saved.item);
        editor.accept({
          version: saved.version,
          item: settings.context_window,
          etag: family
            ? JSON.stringify(contextWindows.map(() => settings.context_window))
            : undefined,
        });
        formApi.reset(settings);
      } catch {
        /* Retain model settings for retry. */
      }
    },
  });
  return (
    <form
      className="space-y-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.AppField name="context_window">
        {(field) => (
          <field.NumberField
            label="Context window (tokens)"
            placeholder="e.g. 1000000"
            hint="Leave empty when unknown. This annotates usage and does not enforce a request limit."
          />
        )}
      </form.AppField>
      <ResourceConflict
        conflict={editor.conflict}
        reload={() => {
          editor.accept({ version, item: contextWindow, etag });
          form.reset({ context_window: contextWindow });
          save.reset();
        }}
      />
      {save.error && <ErrorNotice error={save.error} />}
      <div className="flex justify-end">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(pending) => (
            <Button type="submit" disabled={pending || editor.conflict}>
              Save model settings
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
