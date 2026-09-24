import { createFormHook } from "@tanstack/react-form";
import { fieldContext, formContext } from "./form-context";
import { ProxyGroupField } from "@/components/form/proxy-field";
import {
  FormErrors,
  NumberField,
  NumberListField,
  StringListField,
  TextField,
  ToggleField,
} from "@/components/form/fields";

export const { useAppForm, withForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    NumberField,
    StringListField,
    NumberListField,
    ToggleField,
    ProxyGroupField,
  },
  formComponents: { Errors: FormErrors },
});
