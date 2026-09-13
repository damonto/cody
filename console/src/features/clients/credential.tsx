import type { ComponentProps } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { createClientKey } from "../../../../src/shared/secrets";
import { revealClientKey } from "@/lib/api";
import { useCredential } from "@/lib/use-credential";
import { CredentialField } from "@/components/form/credential-field";
import { Button } from "@/components/ui/button";
import type { FieldError } from "@/components/ui/field";

interface CredentialProps {
  clientId: string;
  version: number;
  value: string;
}

interface ClientCredentialFieldProps extends CredentialProps {
  onChange: (value: string) => void;
  onBlur: () => void;
  errors: ComponentProps<typeof FieldError>["errors"];
}

export function ClientCredential({
  clientId,
  version,
  value,
}: CredentialProps) {
  const credential = useCredential({
    value,
    reveal: (signal) => revealClientKey(clientId, version, signal),
  });
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 font-mono text-muted-foreground">
        sk-cody-******
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy client API key for ${clientId}`}
        aria-busy={credential.status === "copying"}
        disabled={!value || credential.status === "copying"}
        onClick={credential.copy}
      >
        {credential.status === "copying" ? (
          <Loader2 className="animate-spin" />
        ) : credential.status === "copied" ? (
          <Check />
        ) : (
          <Copy />
        )}
      </Button>
    </div>
  );
}

export function ClientCredentialField({
  clientId,
  version,
  ...props
}: ClientCredentialFieldProps) {
  return (
    <CredentialField
      {...props}
      label="Gateway API key"
      name="api_key"
      reveal={(signal) => revealClientKey(clientId, version, signal)}
      generate={createClientKey}
    />
  );
}
