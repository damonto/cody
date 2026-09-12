import { withForm } from "@/lib/form";
import { serviceFormOptions } from "./form-options";
import { TabsContent } from "@/components/ui/tabs";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";

export const CredentialFields = withForm({
  ...serviceFormOptions,

  render: function CredentialFields({ form }) {
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
                            readOnly={
                              key.api_key === "__CODY_SECRET_UNCHANGED__"
                            }
                          />
                        )}
                      </form.AppField>
                      <form.AppField name={`keys[${position}].priority`}>
                        {(field) => <field.NumberField label="Key priority" />}
                      </form.AppField>
                    </div>
                    <form.AppField name={`keys[${position}].api_key`}>
                      {(field) => (
                        <field.TextField label="API key" type="password" />
                      )}
                    </form.AppField>
                    <form.AppField name={`keys[${position}].disabled`}>
                      {(field) => (
                        <field.ToggleField label="Key enabled" inverse />
                      )}
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
