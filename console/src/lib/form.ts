import { createFormHook } from "@tanstack/react-form";
import { fieldContext, formContext } from "./form-context";
import {
  FormErrors,
  NumberField,
  NumberListField,
  StringListField,
  TextField,
  ToggleField,
} from "@/components/form/fields";

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    NumberField,
    StringListField,
    NumberListField,
    ToggleField,
  },
  formComponents: { Errors: FormErrors },
});
