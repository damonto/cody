import { useId, type ComponentProps, type MouseEvent } from "react";
import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { SECRET_PLACEHOLDER } from "../../../../src/shared/secrets";
import { useCredential, type CredentialSource } from "@/lib/use-credential";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface CredentialFieldProps extends CredentialSource {
  label: string;
  name: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  errors: ComponentProps<typeof FieldError>["errors"];
  generate?: () => string;
}

function keepInputFocus(event: MouseEvent<HTMLButtonElement>) {
  // Blur validation can move the button before its click is dispatched.
  event.preventDefault();
}

export function CredentialField({
  label,
  name,
  onChange,
  onBlur,
  errors,
  generate,
  ...source
}: CredentialFieldProps) {
  const id = useId();
  const credential = useCredential(source);
  const invalid = !!errors?.length;
  const loading = credential.status === "revealing";
  const hiding = credential.visible || loading;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          id={id}
          name={name}
          className="pr-9"
          type={credential.visible ? "text" : "password"}
          value={credential.text}
          placeholder={
            source.value === SECRET_PLACEHOLDER
              ? "Saved credential · enter a value to rotate"
              : ""
          }
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            credential.clearRevealedKey();
            onChange(event.target.value);
          }}
          onBlur={onBlur}
          aria-invalid={invalid}
          aria-describedby={`${id}-error`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-0.5 right-0.5"
          aria-label={`${hiding ? "Hide" : "Show"} ${label}`}
          aria-controls={id}
          aria-busy={loading}
          disabled={!source.value}
          onMouseDown={keepInputFocus}
          onClick={credential.toggle}
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : hiding ? (
            <EyeOff />
          ) : (
            <Eye />
          )}
        </Button>
      </div>
      {generate && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onMouseDown={keepInputFocus}
            onClick={() => {
              credential.hide();
              onChange(generate());
            }}
          >
            <RefreshCw />
            Generate new key
          </Button>
        </div>
      )}
      <FieldError id={`${id}-error`} errors={errors} />
    </Field>
  );
}
