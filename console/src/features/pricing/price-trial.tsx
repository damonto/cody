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
import { useId, useState } from "react";
import type { ProviderType } from "../../../../src/config/values.ts";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CACHE_WRITE_DURATIONS,
  CACHE_WRITE_DURATION_GROUPS,
  type CacheDurationFormat,
} from "../../../../src/shared/cache-durations.ts";
import {
  initialPricingDurationFormat,
  pricingDurationFormats,
} from "./cache-durations";

type TrialUsage = z.input<typeof previewSchema.shape.usage>;

function initialTrialUsage(
  format: CacheDurationFormat | undefined,
): TrialUsage {
  const usage: TrialUsage = {
    image_input_tokens: null,
    image_output_tokens: null,
    image_cache_read_tokens: null,
    image_cache_write_tokens: null,
    input_tokens: 220000,
    output_tokens: 4000,
    cache_read_tokens: 140000,
    cache_write_tokens: 20000,
    reasoning_tokens: 1000,
  };
  for (const { tokens } of CACHE_WRITE_DURATIONS) usage[tokens] = null;
  if (format) {
    const [short, long] = CACHE_WRITE_DURATION_GROUPS[format].durations;
    usage[short.tokens] = 20000;
    usage[long.tokens] = 0;
  }
  return usage;
}

export function PriceTrial({
  price,
  providerType,
}: {
  price: ModelPrice;
  providerType: ProviderType;
}) {
  const formats = pricingDurationFormats(providerType, price.pricing?.tiers);
  const initialFormat = initialPricingDurationFormat(
    providerType,
    price.pricing?.tiers,
  );
  const formatId = useId();
  const [format, setFormat] = useState<CacheDurationFormat | undefined>(
    initialFormat,
  );
  const preview = useMutation({
    mutationFn: (usage: TrialUsage) =>
      read(rpc.pricing.preview.$post({ json: { price, usage } })),
  });
  const form = useAppForm({
    defaultValues: initialTrialUsage(initialFormat),
    validators: { onSubmit: previewSchema.shape.usage },
    onSubmit: async ({ value }) => {
      try {
        await preview.mutateAsync(value);
      } catch {
        /* Display below. */
      }
    },
  });
  const result = preview.data;
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {formats.length > 1 && (
        <Field>
          <FieldLabel htmlFor={formatId}>Cache duration format</FieldLabel>
          <Select
            value={format}
            onValueChange={(value) => {
              const selected = formats.find((format) => format === value);
              if (!selected) return;
              setFormat(selected);
              for (const { tokens } of CACHE_WRITE_DURATIONS)
                form.setFieldValue(tokens, null);
              preview.reset();
            }}
          >
            <SelectTrigger id={formatId} className="w-full">
              <SelectValue placeholder="Choose a cache duration format" />
            </SelectTrigger>
            <SelectContent>
              {formats.map((value) => (
                <SelectItem key={value} value={value}>
                  {CACHE_WRITE_DURATION_GROUPS[value].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
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
            ["reasoning_tokens", "Reasoning"],
          ] as const
        ).map(([name, title]) => (
          <form.AppField key={name} name={name}>
            {(field) => <field.NumberField label={title} />}
          </form.AppField>
        ))}
        {format &&
          CACHE_WRITE_DURATION_GROUPS[format].durations.map(
            ({ tokens, label }) => (
              <form.AppField key={tokens} name={tokens}>
                {(field) => <field.NumberField label={label} />}
              </form.AppField>
            ),
          )}
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
      {result && (
        <div className="space-y-4 rounded-xl border bg-muted/30 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm">
              Tier {result.tier_index === null ? "—" : result.tier_index + 1}
            </span>
            <Status value={result.status} />
          </div>
          <p className="text-3xl font-semibold">
            {money(result.total_nano, result.currency)}
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
                <span>{money(result[key], result.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
