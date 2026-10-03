import { useResourceEditor } from "@/lib/use-resource-editor";
import { ResourceConflict } from "@/components/form/resource-conflict";
import type { z } from "zod";
import { useState } from "react";
import { Calculator, History } from "lucide-react";
import { useAppForm } from "@/lib/form";
import { modelPriceSchema } from "../../../../src/billing/schema";
import type { ModelPrice } from "../../../../src/billing/types";
import { type PricingResources } from "@/lib/resources";
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
import { emptyTier, priceFormOptions, priceEditorSchema } from "./form-options";
import { useSaveModelPrice } from "./api";
import { ModelContextForm } from "./model-context-form";
import { PriceTiers } from "./price-tiers";
import { PriceTrial } from "./price-trial";
import { PriceHistory } from "./price-history";

export function PriceForm({
  snapshot,
  providerId,
  model,
}: {
  snapshot: PricingResources;
  providerId: string;
  model: string;
}) {
  const save = useSaveModelPrice();
  const [trial, setTrial] = useState<ModelPrice | null>(null);
  const [tab, setTab] = useState("rates");
  const initialPrice: ModelPrice = snapshot.prices?.find(
    (entry) => entry.provider_id === providerId && entry.model === model,
  ) ?? { provider_id: providerId, model };
  const editor = useResourceEditor({
    version: snapshot.version,
    item: initialPrice,
  });
  const initial: z.input<typeof priceEditorSchema> = editor.initial;
  const provider = snapshot.providers.find((item) => item.id === providerId);
  const modelId = provider?.model_settings?.[model]?.id;
  if (!modelId)
    throw new Error("Provider model is missing from the configuration");
  const form = useAppForm({
    ...priceFormOptions,
    defaultValues: initial,
    onSubmit: async ({ value, formApi }) => {
      const price = modelPriceSchema.parse(value);
      try {
        const saved = await save.mutateAsync({
          modelId,
          pricing: price.pricing,
          version: editor.version,
        });
        const item =
          saved.item === null
            ? { provider_id: providerId, model }
            : modelPriceSchema.parse(saved.item);
        editor.accept({ version: saved.version, item });
        formApi.reset(item);
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
              {provider.name ?? providerId} · Prices per 1 million tokens
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
            <ModelContextForm
              version={snapshot.version}
              providerId={providerId}
              modelId={modelId}
              contextWindow={provider.model_settings?.[model]?.context_window}
            />
            <form
              className="space-y-6 pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
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
                              const result = priceEditorSchema.safeParse(
                                form.state.values,
                              );
                              if (result.success) {
                                setTrial(result.data);
                              } else void form.validate("submit");
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
              <ResourceConflict
                conflict={editor.conflict}
                reload={() => {
                  editor.accept({
                    version: snapshot.version,
                    item: initialPrice,
                  });
                  form.reset(initialPrice);
                  save.reset();
                }}
              />
              {save.error && <ErrorNotice error={save.error} />}
              <div className="flex justify-end border-t pt-4">
                <form.Subscribe selector={(state) => state.isSubmitting}>
                  {(submitting) => (
                    <Button
                      type="submit"
                      disabled={submitting || editor.conflict}
                    >
                      Save model price
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
              timeZone={snapshot.reporting?.time_zone}
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
            {trial && <PriceTrial price={trial} />}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
