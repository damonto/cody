import { withFieldGroup } from "@/lib/form";
import { Button } from "@/components/ui/button";
import { emptyProxyNode } from "./form-options";

export const ProxyNodeInputs = withFieldGroup({
  defaultValues: emptyProxyNode,
  props: { readOnlyId: false },
  render: function ProxyNodeInputs({ group, readOnlyId }) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <group.AppField name="id">
            {(field) => (
              <field.TextField label="Proxy ID" readOnly={readOnlyId} />
            )}
          </group.AppField>
          <group.AppField name="priority">
            {(field) => <field.NumberField label="Priority" />}
          </group.AppField>
        </div>
        <group.AppField name="url">
          {(field) => (
            <field.TextField
              label="SOCKS5 URL"
              type="url"
              placeholder="socks5://proxy.example.com:1080"
            />
          )}
        </group.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <group.AppField name="username">
            {(field) => <field.TextField label="Username" emptyAsUndefined />}
          </group.AppField>
          <group.AppField name="password">
            {(field) => (
              <field.TextField
                label="Password"
                type="password"
                emptyAsUndefined
              />
            )}
          </group.AppField>
        </div>
        <p className="text-xs text-muted-foreground">
          Supply username and password together, or leave both empty.
        </p>
        <group.Subscribe
          selector={(state) =>
            // Array removal can temporarily unbind the group's previous field path.
            state.values?.username !== undefined ||
            state.values?.password !== undefined
          }
        >
          {(authenticated) =>
            authenticated && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  group.setFieldValue("username", undefined);
                  group.setFieldValue("password", undefined);
                }}
              >
                Remove authentication
              </Button>
            )
          }
        </group.Subscribe>
        <group.AppField name="disabled">
          {(field) => <field.ToggleField label="Proxy enabled" inverse />}
        </group.AppField>
      </div>
    );
  },
});
