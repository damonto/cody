import type { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { Calculator } from "lucide-react";
import { useAppForm } from "@/lib/form";
import { previewSchema } from "../../../../src/admin/schema";
import type { ModelPrice } from "../../../../src/billing/types";
import { read, rpc } from "@/lib/api";
import { money } from "@/lib/format";
import { ErrorNotice, Status } from "@/components/common";
import { Button } from "@/components/ui/button";

export function PriceTrial({ price }: { price: ModelPrice }) {
  const preview = useMutation({
    mutationFn: (usage: z.input<typeof previewSchema.shape.usage>) =>
      read(rpc.pricing.preview.$post({ json: { price, usage } })),
  });
  const form = useAppForm({
    defaultValues: {
      image_input_tokens: null,
      image_output_tokens: null,
      image_cache_read_tokens: null,
      image_cache_write_tokens: null,
      input_tokens: 220000,
      output_tokens: 4000,
      cache_read_tokens: 140000,
      cache_write_tokens: 20000,
      cache_write_5m_tokens: 20000,
      cache_write_1h_tokens: 0,
      reasoning_tokens: 1000,
    } as z.input<typeof previewSchema.shape.usage>,
    validators: { onSubmit: previewSchema.shape.usage },
    onSubmit: async ({ value }) => {
      try {
        await preview.mutateAsync(value);
      } catch {
        /* Display below. */
      }
    },
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["input_tokens", "Total input"],
            ["image_input_tokens", "Image input (including cached images)"],
            ["image_output_tokens", "Image output"],
            ["image_cache_write_tokens", "Image cache write"],
            ["image_cache_read_tokens", "Image cache read"],
            ["output_tokens", "Output (including reasoning)"],
            ["cache_read_tokens", "Cache read"],
            ["cache_write_tokens", "Cache write"],
            ["cache_write_5m_tokens", "Cache write · 5 minutes"],
            ["cache_write_1h_tokens", "Cache write · 1 hour"],
            ["reasoning_tokens", "Reasoning"],
          ] as const
        ).map(([name, title]) => (
          <form.AppField key={name} name={name}>
            {(field) => <field.NumberField label={title} />}
          </form.AppField>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Image counters are subsets of the totals, not additional tokens. Leave
        unknown counters blank. Incomplete costs include only known charges.
      </p>
      <Button type="submit" disabled={preview.isPending}>
        <Calculator />
        Calculate cost
      </Button>
      {preview.error && <ErrorNotice error={preview.error} />}
      {preview.data && (
        <div className="space-y-4 rounded-xl border bg-muted/30 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm">
              Tier{" "}
              {preview.data.tier_index === null
                ? "—"
                : preview.data.tier_index + 1}
            </span>
            <Status value={preview.data.status} />
          </div>
          <p className="text-3xl font-semibold">
            {money(preview.data.total_nano, preview.data.currency)}
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs">
            {(
              [
                ["input_nano", "Input"],
                ["image_input_nano", "Image input"],
                ["image_output_nano", "Image output"],
                ["image_cache_write_nano", "Image cache write"],
                ["image_cache_read_nano", "Image cache read"],
                ["output_nano", "Output"],
                ["cache_write_nano", "Cache write"],
                ["cache_read_nano", "Cache read"],
              ] as const
            ).map(([key, title]) => (
              <div key={key} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{title}</span>
                <span>{money(preview.data![key], preview.data!.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
