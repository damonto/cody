import { formOptions } from "@tanstack/react-form";
import { z } from "zod";
import {
  proxyGroupSchema,
  proxyNodeSchema,
} from "../../../../src/config/schema";
import type { ProxyGroupConfig } from "../../../../src/config/types";

export const proxyGroupEditorSchema = proxyGroupSchema
  .extend({
    proxies: z.array(proxyNodeSchema.safeExtend({ rowId: z.string().min(1) })),
  })
  .transform(({ proxies, ...group }) => ({
    ...group,
    proxies: proxies.map(({ rowId: _rowId, ...node }) => node),
  }))
  .pipe(proxyGroupSchema);

type ProxyGroupFormValues = z.input<typeof proxyGroupEditorSchema>;

export const emptyProxyNode: z.input<typeof proxyNodeSchema> = {
  id: "",
  url: "",
  priority: 100,
  disabled: false,
};
export const proxyNodeEditorSchema = z.strictObject({ node: proxyNodeSchema });
export const proxyNodeFormOptions = formOptions({
  defaultValues: { node: emptyProxyNode },
  validators: {
    onSubmit: proxyNodeEditorSchema,
    onChange: proxyNodeEditorSchema,
  },
});

export function proxyGroupFormValues(
  group?: ProxyGroupConfig,
): ProxyGroupFormValues {
  return {
    id: group?.id ?? "",
    strategy: group?.strategy ?? "random",
    proxies: (group?.proxies ?? []).map((node) => ({
      ...node,
      rowId: crypto.randomUUID(),
    })),
  };
}

export function newProxyNode(): ProxyGroupFormValues["proxies"][number] {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    id: `proxy-${rowId.slice(0, 6)}`,
    url: "",
    priority: 100,
    disabled: false,
  };
}

export const proxyGroupFormOptions = formOptions({
  defaultValues: proxyGroupFormValues(),
  validators: {
    onSubmit: proxyGroupEditorSchema,
    onChange: proxyGroupEditorSchema,
  },
});
