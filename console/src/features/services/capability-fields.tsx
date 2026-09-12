import { withForm } from "@/lib/form";
import { serviceFormOptions } from "./form-options";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { fieldErrors } from "@/lib/form-errors";

export const CapabilityFields = withForm({
  ...serviceFormOptions,

  render: function CapabilityFields({ form }) {
    return (
      <TabsContent
        value="routing"
        forceMount
        className="space-y-6 data-[state=inactive]:hidden"
      >
        <form.AppField name="supports_websocket">
          {(field) => (
            <field.ToggleField
              label="Responses WebSocket"
              hint="This upstream supports the Responses WebSocket protocol."
            />
          )}
        </form.AppField>
        <form.AppField name="supports_context_management">
          {(field) => (
            <field.ToggleField
              label="Native context management"
              hint="Allow supported history and notes endpoints with pinned sessions."
            />
          )}
        </form.AppField>
        <form.AppField name="supports_web_search">
          {(field) => <field.ToggleField label="Native web search" />}
        </form.AppField>
        <form.AppField name="retry">
          {(field) => (
            <div className="space-y-4 border-t pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Retry policy</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    field.handleChange(
                      field.state.value
                        ? undefined
                        : { status_codes: [503], delays_ms: [1000] },
                    )
                  }
                >
                  {field.state.value ? "Disable retries" : "Enable retries"}
                </Button>
              </div>
              {field.state.value && (
                <>
                  <form.AppField name="retry.status_codes">
                    {(codes) => (
                      <codes.NumberListField
                        label="Retry HTTP status codes"
                        hint="400–599, separated by commas."
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="retry.delays_ms">
                    {(delays) => (
                      <delays.NumberListField
                        label="Retry delays (milliseconds)"
                        hint="One delay per retry, at most 10 retries. No service or key switching."
                      />
                    )}
                  </form.AppField>
                  <FieldError errors={fieldErrors(field)} />
                </>
              )}
            </div>
          )}
        </form.AppField>
      </TabsContent>
    );
  },
});
