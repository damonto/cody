import type { z } from "zod";
import { formOptions } from "@tanstack/react-form";
import { serviceFormSchema } from "../../../../src/shared/forms";

export function newService(): z.input<typeof serviceFormSchema> {
  return {
    id: "",
    base_url: "",
    models: [],
    keys: [{ id: "primary", api_key: "", priority: 100, disabled: false }],
    disabled: false,
    priority: 100,
    supports_websocket: false,
    supports_web_search: false,
    supports_context_management: false,
  };
}
export const serviceFormOptions = formOptions({
  defaultValues: newService(),
  validators: { onSubmit: serviceFormSchema, onBlur: serviceFormSchema },
});
