import { Plus, Trash2 } from "lucide-react";
import { withForm } from "@/lib/form";
import { fieldErrors } from "@/lib/form-errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { newProxyNode, proxyGroupFormOptions } from "./form-options";
import { ProxyNodeInputs } from "./node-inputs";

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
                <CardContent>
                  {/* Field groups capture their path on mount; rebind when a row moves. */}
                  <ProxyNodeInputs
                    key={position}
                    form={form}
                    fields={`proxies[${position}]`}
                    readOnlyId={savedRowIds.includes(node.rowId)}
                  />
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
