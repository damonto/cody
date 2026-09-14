import { useId } from "react";
import type { SocksProxyConfig } from "../../../../src/config/types";
import { useFieldContext } from "@/lib/form-context";
import { fieldErrors } from "@/lib/form-errors";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function SocksProxyField({ inherit = false }: { inherit?: boolean }) {
  const field = useFieldContext<SocksProxyConfig | null | undefined>();
  const id = useId();
  const proxy = field.state.value;
  const mode = proxy
    ? "socks5"
    : inherit && proxy === undefined
      ? "inherit"
      : "direct";
  const hasSavedPassword = proxy?.password === "__CODY_SECRET_UNCHANGED__";
  return (
    <Field data-invalid={field.state.meta.errors.length > 0}>
      <FieldLabel htmlFor={id}>Outbound proxy</FieldLabel>
      <Select
        value={mode}
        onValueChange={(value) => {
          field.handleChange(
            value === "socks5"
              ? { url: "" }
              : value === "inherit" || !inherit
                ? undefined
                : null,
          );
        }}
      >
        <SelectTrigger id={id} className="w-full" onBlur={field.handleBlur}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inherit && (
            <SelectItem value="inherit">Use provider proxy</SelectItem>
          )}
          <SelectItem value="direct">Direct connection</SelectItem>
          <SelectItem value="socks5">SOCKS5</SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>
        {inherit
          ? "This key can override the provider proxy or connect directly."
          : "Used by provider credentials that inherit this setting."}
      </FieldDescription>
      {proxy && (
        <div className="space-y-3 rounded-lg border p-3">
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>SOCKS5 URL</FieldLabel>
            <Input
              id={`${id}-url`}
              type="url"
              value={proxy.url}
              placeholder="socks5://proxy.example.com:1080"
              autoComplete="off"
              onBlur={field.handleBlur}
              onChange={(event) =>
                field.handleChange({ ...proxy, url: event.target.value })
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-username`}>Username</FieldLabel>
              <Input
                id={`${id}-username`}
                value={proxy.username ?? ""}
                autoComplete="off"
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange({
                    ...proxy,
                    username: event.target.value || undefined,
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
              <Input
                id={`${id}-password`}
                type="password"
                value={hasSavedPassword ? "" : (proxy.password ?? "")}
                placeholder={
                  hasSavedPassword
                    ? "Saved password · enter a value to rotate"
                    : undefined
                }
                autoComplete="new-password"
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange({
                    ...proxy,
                    password: event.target.value || undefined,
                  })
                }
              />
            </Field>
          </div>
          <FieldDescription>
            Leave both credentials empty for a proxy without authentication.
          </FieldDescription>
          {(proxy.username !== undefined || proxy.password !== undefined) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => field.handleChange({ url: proxy.url })}
            >
              Remove authentication
            </Button>
          )}
        </div>
      )}
      <FieldError errors={fieldErrors(field)} />
    </Field>
  );
}
