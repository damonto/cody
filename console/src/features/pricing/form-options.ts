import { formOptions } from "@tanstack/react-form";
import { modelPolicySchema } from "../../../../src/billing/schema";
import type { ModelPolicy, PriceTier } from "../../../../src/billing/types";

export const emptyTier = (): PriceTier => ({
  up_to_input_tokens: null,
  input: "",
  output: "",
  cache_write: "",
  cache_read: "",
});
const defaultPolicy: ModelPolicy = { service_id: "", model: "" };
export const policyFormOptions = formOptions({
  defaultValues: defaultPolicy,
  validators: { onBlur: modelPolicySchema, onSubmit: modelPolicySchema },
});
