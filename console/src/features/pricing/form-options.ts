import type { z } from "zod";
import { formOptions } from "@tanstack/react-form";
import { modelPriceSchema } from "../../../../src/billing/schema";
import type { PriceTier } from "../../../../src/billing/types";

export const emptyTier = (): PriceTier => ({
  up_to_input_tokens: null,
  input: "",
  output: "",
  cache_write: "",
  cache_read: "",
});
export const priceEditorSchema = modelPriceSchema;
const defaultPrice: z.input<typeof priceEditorSchema> = {
  provider_id: "",
  model: "",
};
export const priceFormOptions = formOptions({
  defaultValues: defaultPrice,
  validators: { onBlur: priceEditorSchema, onSubmit: priceEditorSchema },
});
