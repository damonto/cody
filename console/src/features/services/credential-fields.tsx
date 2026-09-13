import { withForm } from "@/lib/form";
import { serviceFormOptions } from "./form-options";
import { SECRET_PLACEHOLDER } from "../../../../src/shared/secrets";
import { revealServiceKey } from "@/lib/api";
import { CredentialField } from "@/components/form/credential-field";
import { TabsContent } from "@/components/ui/tabs";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";

export const CredentialFields = withForm({
  ...serviceFormOptions,
  props: { serviceId: "", version: 0, draftVersion: 0 },
  render: function CredentialFields({
    form,
    serviceId,
    version,
    draftVersion,
  }) {
    return (
      <TabsContent
        value="keys"
        forceMount
        className="space-y-4 data-[state=inactive]:hidden"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          Retries use the same selected key. Saved secret values are hidden;
          enter a new value to rotate a credential.
        </p>
        <form.AppField name="keys" mode="array">
          {(keys) => (
            <>
              {keys.state.value.map((key, position) => (
                <Card key={position} className="shadow-none">
                  <CardHeader className="flex-row items-center justify-between">
                    <CardTitle className="text-sm">
                      Credential {position + 1}
                    </CardTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={keys.state.value.length === 1}
                      aria-label={`Remove credential ${position + 1}`}
                      onClick={() => keys.removeValue(position)}
                    >
                      <Trash2 />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <form.AppField name={`keys[${position}].id`}>
                        {(field) => (
                          <field.TextField
                            label="Key ID"
                            readOnly={key.api_key === SECRET_PLACEHOLDER}
                          />
                        )}
                      </form.AppField>
                      <form.AppField name={`keys[${position}].priority`}>
                        {(field) => <field.NumberField label="Key priority" />}
                      </form.AppField>
                    </div>
                    <form.AppField name={`keys[${position}].api_key`}>
                      {(field) => (
                        <CredentialField
                          key={`${serviceId}:${key.id}:${version}:${draftVersion}`}
                          label="API key"
                          name={field.name}
                          value={field.state.value}
                          onChange={field.handleChange}
                          onBlur={field.handleBlur}
                          errors={fieldErrors(field)}
                          reveal={(signal) =>
                            revealServiceKey(serviceId, key.id, version, signal)
                          }
                        />
                      )}
                    </form.AppField>
                    <form.AppField name={`keys[${position}].disabled`}>
                      {(field) => (
                        <field.ToggleField label="Key enabled" inverse />
                      )}
                    </form.AppField>
                    <form.AppField name={`keys[${position}].proxy`}>
                      {(field) => <field.SocksProxyField inherit />}
                    </form.AppField>
                  </CardContent>
                </Card>
              ))}
              <FieldError errors={fieldErrors(keys)} />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  keys.pushValue({
                    id: `key-${crypto.randomUUID().slice(0, 6)}`,
                    api_key: "",
                    priority: 50,
                    disabled: false,
                  })
                }
              >
                <Plus />
                Add key
              </Button>
            </>
          )}
        </form.AppField>
      </TabsContent>
    );
  },
});
