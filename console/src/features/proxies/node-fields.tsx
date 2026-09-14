import { Plus, Trash2 } from "lucide-react";
import { withForm } from "@/lib/form";
import { fieldErrors } from "@/lib/form-errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { newProxyNode, proxyGroupFormOptions } from "./form-options";

const NO_SAVED_ROWS: readonly string[] = [];

export const ProxyNodeFields = withForm({
  ...proxyGroupFormOptions,
  props: { savedRowIds: NO_SAVED_ROWS },
  render: function ProxyNodeFields({ form, savedRowIds }) {
    return (
      <form.AppField name="proxies" mode="array">
        {(nodes) => (
          <div className="space-y-4">
            {nodes.state.value.map((node, position) => (
              <Card key={node.rowId} className="shadow-none">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="text-sm">
                    Proxy {position + 1}
                  </CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove proxy ${position + 1}`}
                    onClick={() => nodes.removeValue(position)}
                  >
                    <Trash2 />
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <form.AppField name={`proxies[${position}].id`}>
                      {(field) => (
                        <field.TextField
                          label="Proxy ID"
                          readOnly={savedRowIds.includes(node.rowId)}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name={`proxies[${position}].priority`}>
                      {(field) => <field.NumberField label="Priority" />}
                    </form.AppField>
                  </div>
                  <form.AppField name={`proxies[${position}].url`}>
                    {(field) => (
                      <field.TextField
                        label="SOCKS5 URL"
                        type="url"
                        placeholder="socks5://proxy.example.com:1080"
                      />
                    )}
                  </form.AppField>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <form.AppField name={`proxies[${position}].username`}>
                      {(field) => (
                        <field.TextField label="Username" emptyAsUndefined />
                      )}
                    </form.AppField>
                    <form.AppField name={`proxies[${position}].password`}>
                      {(field) => (
                        <field.TextField
                          label="Password"
                          type="password"
                          emptyAsUndefined
                        />
                      )}
                    </form.AppField>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Supply username and password together, or leave both empty.
                  </p>
                  {(node.username !== undefined ||
                    node.password !== undefined) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        form.setFieldValue(
                          `proxies[${position}].username`,
                          undefined,
                        );
                        form.setFieldValue(
                          `proxies[${position}].password`,
                          undefined,
                        );
                      }}
                    >
                      Remove authentication
                    </Button>
                  )}
                  <form.AppField name={`proxies[${position}].disabled`}>
                    {(field) => (
                      <field.ToggleField label="Proxy enabled" inverse />
                    )}
                  </form.AppField>
                </CardContent>
              </Card>
            ))}
            <FieldError errors={fieldErrors(nodes)} />
            <Button
              type="button"
              variant="outline"
              onClick={() => nodes.pushValue(newProxyNode())}
            >
              <Plus />
              Add proxy
            </Button>
          </div>
        )}
      </form.AppField>
    );
  },
});
