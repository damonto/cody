import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { useStore } from "@tanstack/react-form";
import { SECRET_PLACEHOLDER } from "../../../../src/shared/secrets";
import { useFieldContext, useFormContext } from "@/lib/form-context";
import { fieldErrors, validationErrors } from "@/lib/form-errors";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

interface FieldProps {
  label: string;
  hint?: string;
}
type InputProps = FieldProps &
  Pick<ComponentProps<typeof Input>, "placeholder" | "readOnly">;

function FieldFrame({
  id,
  label,
  hint,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  const field = useFieldContext<unknown>();
  return (
    <Field data-invalid={field.state.meta.errors.length > 0}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      <FieldError id={`${id}-error`} errors={fieldErrors(field)} />
    </Field>
  );
}

export function TextField({
  label,
  hint,
  type = "text",
  emptyAsUndefined = false,
  placeholder,
  readOnly,
}: InputProps & {
  type?: "text" | "password" | "url";
  emptyAsUndefined?: boolean;
}) {
  const field = useFieldContext<string | undefined>();
  const id = useId();
  const secret = field.state.value === SECRET_PLACEHOLDER;
  function change(value: string) {
    field.handleChange(emptyAsUndefined && !value ? undefined : value);
  }
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <Input
        id={id}
        name={field.name}
        value={secret ? "" : (field.state.value ?? "")}
        onChange={(event) => change(event.target.value)}
        onBlur={field.handleBlur}
        type={type}
        placeholder={
          secret ? "Saved credential · enter a value to rotate" : placeholder
        }
        readOnly={readOnly}
        autoComplete={type === "password" ? "new-password" : "off"}
        aria-invalid={field.state.meta.errors.length > 0}
        aria-describedby={`${id}-hint ${id}-error`}
      />
    </FieldFrame>
  );
}

export function NumberField({
  label,
  hint,
  placeholder,
  readOnly,
}: InputProps) {
  const field = useFieldContext<number | null | undefined>();
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <Input
        id={id}
        name={field.name}
        type="number"
        value={field.state.value ?? ""}
        onBlur={field.handleBlur}
        onChange={(event) =>
          field.handleChange(
            event.target.value === "" ? undefined : event.target.valueAsNumber,
          )
        }
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={field.state.meta.errors.length > 0}
        aria-describedby={`${id}-hint ${id}-error`}
      />
    </FieldFrame>
  );
}

function ListInput({
  label,
  hint,
  value,
  onChange,
  numeric = false,
}: FieldProps & {
  value: readonly (string | number)[];
  onChange: (value: string[]) => void;
  numeric?: boolean;
}) {
  const field = useFieldContext<unknown>();
  const id = useId();
  const [text, setText] = useState(() => value.join(numeric ? ", " : "\n"));
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <Textarea
        id={id}
        name={field.name}
        value={text}
        rows={numeric ? 2 : 4}
        onBlur={field.handleBlur}
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            event.target.value
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter(Boolean),
          );
        }}
        aria-invalid={field.state.meta.errors.length > 0}
        aria-describedby={`${id}-hint ${id}-error`}
      />
    </FieldFrame>
  );
}
export function StringListField(props: FieldProps) {
  const field = useFieldContext<string[]>();
  return (
    <ListInput
      {...props}
      value={field.state.value}
      onChange={field.handleChange}
    />
  );
}
export function NumberListField(props: FieldProps) {
  const field = useFieldContext<number[] | undefined>();
  return (
    <ListInput
      {...props}
      value={field.state.value ?? []}
      numeric
      onChange={(values) => field.handleChange(values.map(Number))}
    />
  );
}
export function ToggleField({
  label,
  hint,
  inverse = false,
}: FieldProps & { inverse?: boolean }) {
  const field = useFieldContext<boolean | undefined>();
  const id = useId();
  return (
    <Field orientation="horizontal" className="justify-between">
      <div>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </div>
      <Switch
        id={id}
        checked={inverse ? !field.state.value : !!field.state.value}
        onCheckedChange={(value) =>
          field.handleChange(inverse ? !value : value)
        }
        onBlur={field.handleBlur}
      />
    </Field>
  );
}
export function FormErrors() {
  const form = useFormContext();
  const errors = useStore(form.store, (state) => state.errors);
  return <FieldError errors={validationErrors(errors)} />;
}
