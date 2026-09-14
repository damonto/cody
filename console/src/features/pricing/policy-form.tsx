import { useState } from "react";
import { Calculator, History } from "lucide-react";
import { useAppForm } from "@/lib/form";
import { modelPolicySchema } from "../../../../src/billing/schema";
import type { ModelPolicy } from "../../../../src/billing/types";
import { useSaveDraft, type Draft } from "@/lib/api";
import { ErrorNotice } from "@/components/common";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { emptyTier, policyFormOptions } from "./form-options";
import { updatePolicy } from "./mutations";
import { PriceTiers } from "./price-tiers";
import { PriceTrial } from "./price-trial";
import { PriceHistory } from "./price-history";

export function PolicyForm({
  snapshot,
  providerId,
  model,
}: {
  snapshot: Draft;
  providerId: string;
  model: string;
}) {
  const save = useSaveDraft();
  const [trial, setTrial] = useState<ModelPolicy | null>(null);
  const [tab, setTab] = useState("rates");
  const initial: ModelPolicy = snapshot.config.model_policies?.find(
    (entry) => entry.provider_id === providerId && entry.model === model,
  ) ?? { provider_id: providerId, model };
  const form = useAppForm({
    ...policyFormOptions,
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const next = updatePolicy(
        snapshot.config,
        modelPolicySchema.parse(value),
      );
      try {
        await save.mutateAsync({ config: next, version: snapshot.version });
      } catch {
        /* Keep the form for correction. */
      }
    },
  });
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{model}</CardTitle>
            <CardDescription className="mt-1.5">
              {providerId} · Prices per 1 million tokens
            </CardDescription>
          </div>
          <Badge variant="outline">Provider + model</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="rates">Rates & context</TabsTrigger>
            <TabsTrigger value="history">
              <History />
              Price history
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="rates"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <form
              className="space-y-6 pt-4"
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
              <form.AppField name="pricing">
                {(pricing) => (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
                      <div>
                        <h3 className="text-sm font-medium">Token prices</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Unconfigured prices are marked as unpriced.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          pricing.handleChange(
                            pricing.state.value
                              ? undefined
                              : { currency: "USD", tiers: [emptyTier()] },
                          )
                        }
                      >
                        {pricing.state.value
                          ? "Remove pricing"
                          : "Configure prices"}
                      </Button>
                    </div>
                    {pricing.state.value && (
                      <>
                        <div className="flex flex-wrap items-end gap-4">
                          <div className="w-40">
                            <form.AppField name="pricing.currency">
                              {(field) => (
                                <field.TextField
                                  label="Currency"
                                  placeholder="USD"
                                />
                              )}
                            </form.AppField>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              const result = modelPolicySchema.safeParse(
                                form.state.values,
                              );
                              if (result.success) setTrial(result.data);
                              else void form.validate("submit");
                            }}
                          >
                            <Calculator />
                            Test pricing
                          </Button>
                        </div>
                        <div className="rounded-lg bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
                          The total input context, including cache reads and
                          writes, selects one tier for the entire request. Each
                          upper bound is inclusive. Reasoning is already
                          included in the Output charge.
                        </div>
                        <PriceTiers form={form} />
                        <FieldError errors={fieldErrors(pricing)} />
                      </>
                    )}
                  </>
                )}
              </form.AppField>
              {save.error && <ErrorNotice error={save.error} />}
              <div className="flex justify-end border-t pt-4">
                <form.Subscribe selector={(state) => state.isSubmitting}>
                  {(submitting) => (
                    <Button type="submit" disabled={submitting}>
                      Save model policy
                    </Button>
                  )}
                </form.Subscribe>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="history">
            <PriceHistory
              providerId={providerId}
              model={model}
              enabled={tab === "history"}
              timeZone={snapshot.config.reporting?.time_zone}
            />
          </TabsContent>
        </Tabs>
        <Dialog
          open={trial !== null}
          onOpenChange={(open) => {
            if (!open) setTrial(null);
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Pricing calculator</DialogTitle>
              <DialogDescription>
                Test the rates currently in this editor. Input is the total
                context including cache tokens.
              </DialogDescription>
            </DialogHeader>
            {trial && <PriceTrial policy={trial} />}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
