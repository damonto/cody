import { withForm } from "@/lib/form";
import { fieldErrors } from "@/lib/form-errors";
import { number } from "@/lib/format";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FieldError } from "@/components/ui/field";
import { policyFormOptions } from "./form-options";

export const PriceTiers = withForm({
  ...policyFormOptions,
  render: function PriceTiers({ form }) {
    return (
      <form.AppField name="pricing.tiers" mode="array">
        {(tiers) => (
          <div className="space-y-4">
            {(tiers.state.value ?? []).map((tier, index) => (
              <div key={index} className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Tier {index + 1}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {index === 0
                        ? "From 0 tokens"
                        : `Above ${number(tiers.state.value?.[index - 1]?.up_to_input_tokens)} tokens`}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove tier ${index + 1}`}
                    disabled={(tiers.state.value?.length ?? 0) === 1}
                    onClick={() => {
                      const next = structuredClone(tiers.state.value ?? []);
                      next.splice(index, 1);
                      next[next.length - 1].up_to_input_tokens = null;
                      tiers.handleChange(next);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {tier.up_to_input_tokens === null ? (
                  <p className="rounded-md bg-muted/50 p-2 text-xs">
                    All remaining context sizes · No upper bound
                  </p>
                ) : (
                  <form.AppField
                    name={`pricing.tiers[${index}].up_to_input_tokens`}
                  >
                    {(field) => (
                      <field.NumberField label="Up to input tokens (inclusive)" />
                    )}
                  </form.AppField>
                )}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {(
                    [
                      ["input", "Input"],
                      ["output", "Output"],
                      ["cache_write", "Cache write"],
                      ["cache_read", "Cache read"],
                    ] as const
                  ).map(([key, title]) => (
                    <form.AppField
                      key={key}
                      name={`pricing.tiers[${index}].${key}`}
                    >
                      {(field) => (
                        <field.TextField label={title} placeholder="0.00" />
                      )}
                    </form.AppField>
                  ))}
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Optional cache duration prices
                  </summary>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <form.AppField
                      name={`pricing.tiers[${index}].cache_write_5m`}
                    >
                      {(field) => (
                        <field.TextField
                          label="Cache write · 5 minutes"
                          emptyAsUndefined
                          placeholder={
                            tier.cache_write || "Use cache write rate"
                          }
                        />
                      )}
                    </form.AppField>
                    <form.AppField
                      name={`pricing.tiers[${index}].cache_write_1h`}
                    >
                      {(field) => (
                        <field.TextField
                          label="Cache write · 1 hour"
                          emptyAsUndefined
                          placeholder={
                            tier.cache_write || "Use cache write rate"
                          }
                        />
                      )}
                    </form.AppField>
                  </div>
                  <p className="mt-3 text-muted-foreground">
                    Separate rates require the upstream to report cache duration
                    counters.
                  </p>
                </details>
              </div>
            ))}
            <FieldError errors={fieldErrors(tiers)} />
            <Button
              type="button"
              variant="outline"
              disabled={(tiers.state.value?.length ?? 0) >= 20}
              onClick={() => {
                const next = structuredClone(tiers.state.value ?? []);
                const last = next.at(-1);
                if (last) {
                  last.up_to_input_tokens =
                    (next.at(-2)?.up_to_input_tokens ?? 0) + 200000;
                  next.push({
                    ...last,
                    up_to_input_tokens: null,
                  });
                }
                tiers.handleChange(next);
              }}
            >
              <Plus />
              Add context tier
            </Button>
          </div>
        )}
      </form.AppField>
    );
  },
});
