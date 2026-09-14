import { withForm } from "@/lib/form";
import { newCredential, providerFormOptions } from "./form-options";
import { SECRET_PLACEHOLDER } from "../../../../src/shared/secrets";
import { revealProviderCredential } from "@/lib/api";
import { CredentialField } from "@/components/form/credential-field";
import { TabsContent } from "@/components/ui/tabs";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";
import type { ProxyGroupConfig } from "../../../../src/config/types";

export const CredentialFields = withForm({
  ...providerFormOptions,
  props: {
    providerId: "",
    version: 0,
    draftVersion: 0,
    groups: new Array<ProxyGroupConfig>(),
  },
  render: function CredentialFields({
    form,
    providerId,
    version,
    draftVersion,
    groups,
  }) {
    return (
      <TabsContent
        value="credentials"
        forceMount
        className="space-y-4 data-[state=inactive]:hidden"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          Retries use the same selected credential. Saved secret values are
          hidden; enter a new value to rotate a credential.
        </p>
        <form.AppField name="credentials" mode="array">
          {(credentials) => (
            <>
              {credentials.state.value.map((credential, position) => (
                <Card key={credential.rowId} className="shadow-none">
                  <CardHeader className="flex-row items-center justify-between">
                    <CardTitle className="text-sm">
                      Credential {position + 1}
                    </CardTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={credentials.state.value.length === 1}
                      aria-label={`Remove credential ${position + 1}`}
                      onClick={() => credentials.removeValue(position)}
                    >
                      <Trash2 />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <form.AppField name={`credentials[${position}].id`}>
                        {(field) => (
                          <field.TextField
                            label="Credential ID"
                            readOnly={
                              credential.auth.api_key === SECRET_PLACEHOLDER
                            }
                          />
                        )}
                      </form.AppField>
                      <form.AppField name={`credentials[${position}].priority`}>
                        {(field) => (
                          <field.NumberField label="Credential priority" />
                        )}
                      </form.AppField>
                    </div>
                    <form.AppField
                      name={`credentials[${position}].auth.api_key`}
                    >
                      {(field) => (
                        <CredentialField
                          key={`${providerId}:${credential.id}:${field.name}:${version}:${draftVersion}`}
                          label="API key"
                          name={field.name}
                          value={field.state.value}
                          onChange={field.handleChange}
                          onBlur={field.handleBlur}
                          errors={fieldErrors(field)}
                          reveal={(signal) =>
                            revealProviderCredential(
                              providerId,
                              credential.id,
                              version,
                              signal,
                            )
                          }
                        />
                      )}
                    </form.AppField>
                    <form.AppField name={`credentials[${position}].disabled`}>
                      {(field) => (
                        <field.ToggleField label="Credential enabled" inverse />
                      )}
                    </form.AppField>
                    <form.AppField
                      name={`credentials[${position}].proxy_group`}
                    >
                      {(field) => (
                        <field.ProxyGroupField inherit groups={groups} />
                      )}
                    </form.AppField>
                  </CardContent>
                </Card>
              ))}
              <FieldError errors={fieldErrors(credentials)} />
              <Button
                type="button"
                variant="outline"
                onClick={() => credentials.pushValue(newCredential())}
              >
                <Plus />
                Add credential
              </Button>
            </>
          )}
        </form.AppField>
      </TabsContent>
    );
  },
});
