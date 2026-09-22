import { withForm } from "@/lib/form";
import { providerFormOptions } from "./form-options";
import { TabsContent } from "@/components/ui/tabs";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProxyGroupConfig } from "../../../../src/config/types";

export const ConnectionFields = withForm({
  ...providerFormOptions,
  props: { index: -1, close: () => {}, groups: new Array<ProxyGroupConfig>() },
  render: function ConnectionFields({ form, index, close, groups }) {
    return (
      <TabsContent
        value="connection"
        forceMount
        className="space-y-5 data-[state=inactive]:hidden"
      >
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Provider type</span>
          <Badge variant="secondary">AI Gateway</Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="id">
            {(field) => (
              <field.TextField
                label="Provider ID"
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
        <form.AppField name="proxy_group">
          {(field) => <field.ProxyGroupField groups={groups} />}
        </form.AppField>
        <form.AppField name="models">
          {(field) => (
            <field.StringListField
              label="Models"
              hint="One model name per line. Configure client aliases under Model routes."
            />
          )}
        </form.AppField>
        <form.AppField name="disabled">
          {(field) => <field.ToggleField inverse label="Provider enabled" />}
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
