import { useId } from "react";
import type { ProxyGroupConfig } from "../../../../src/config/types";
import { useFieldContext } from "@/lib/form-context";
import { fieldErrors } from "@/lib/form-errors";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ProxyGroupField({
  groups,
  inherit = false,
}: {
  groups: readonly ProxyGroupConfig[];
  inherit?: boolean;
}) {
  const field = useFieldContext<string | null | undefined>();
  const id = useId();
  const group = field.state.value;
  const value = group
    ? `group:${group}`
    : inherit && group === undefined
      ? "inherit"
      : "direct";
  return (
    <Field data-invalid={field.state.meta.errors.length > 0}>
      <FieldLabel htmlFor={id}>Proxy group</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) =>
          field.handleChange(
            next.startsWith("group:")
              ? next.slice(6)
              : next === "inherit"
                ? undefined
                : null,
          )
        }
      >
        <SelectTrigger id={id} className="w-full" onBlur={field.handleBlur}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inherit && (
            <SelectItem value="inherit">Use provider proxy group</SelectItem>
          )}
          <SelectItem value="direct">Direct connection</SelectItem>
          {groups.map((entry) => (
            <SelectItem key={entry.id} value={`group:${entry.id}`}>
              {entry.id} · {entry.strategy}
            </SelectItem>
          ))}
          {group && !groups.some((entry) => entry.id === group) && (
            <SelectItem value={`group:${group}`} disabled>
              {group} · missing group
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      <FieldDescription>
        {inherit
          ? "Inherited sticky groups share the provider's fixed proxy. Choosing a group gives this credential its own binding."
          : "Credentials inherit this group unless they select another group or connect directly."}
      </FieldDescription>
      <FieldError errors={fieldErrors(field)} />
    </Field>
  );
}
