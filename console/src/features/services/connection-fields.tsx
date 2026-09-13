import { withForm } from "@/lib/form";
import { serviceFormOptions } from "./form-options";
import { TabsContent } from "@/components/ui/tabs";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const ConnectionFields = withForm({
  ...serviceFormOptions,
  props: { index: -1, close: () => {} },
  render: function ConnectionFields({ form, index, close }) {
    return (
      <TabsContent
        value="connection"
        forceMount
        className="space-y-5 data-[state=inactive]:hidden"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="id">
            {(field) => (
              <field.TextField
                label="Service ID"
                readOnly={index !== -1}
                hint="Stable identifier used by routes, clients, and historical records."
              />
            )}
          </form.AppField>
          <form.AppField name="priority">
            {(field) => <field.NumberField label="Priority" />}
          </form.AppField>
        </div>
        <form.AppField name="base_url">
          {(field) => (
            <field.TextField
              label="Upstream base URL"
              placeholder="https://api.provider.com/v1"
            />
          )}
        </form.AppField>
        <form.AppField name="proxy">
          {(field) => <field.SocksProxyField />}
        </form.AppField>
        <form.AppField name="models">
          {(field) => (
            <field.StringListField
              label="Upstream models"
              hint="Real provider model names, one per line. Configure client aliases under Model routes."
            />
          )}
        </form.AppField>
        <form.AppField name="disabled">
          {(field) => <field.ToggleField inverse label="Service enabled" />}
        </form.AppField>
        <Button asChild variant="link" className="px-0">
          <Link to="/pricing" onClick={close}>
            Configure model pricing
            <ArrowUpRight />
          </Link>
        </Button>
      </TabsContent>
    );
  },
});
