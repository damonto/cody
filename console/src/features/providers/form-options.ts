import { z } from "zod";
import { formOptions } from "@tanstack/react-form";
import {
  aiGatewayProviderSchema,
  credentialSchema,
  providerSchema,
} from "../../../../src/config/schema";
import type { ProviderConfig } from "../../../../src/config/types";

// Form identity stays stable when an editable credential ID or position changes.
// The final parse strips UI metadata and applies the shared configuration rules.
export const providerEditorSchema = aiGatewayProviderSchema
  .extend({
    credentials: z.array(credentialSchema.extend({ rowId: z.string().min(1) })),
  })
  .transform(
    ({ credentials, ...provider }): z.input<typeof providerSchema> => ({
      ...provider,
      credentials: credentials.map(
        ({ rowId: _rowId, ...credential }) => credential,
      ),
    }),
  )
  .pipe(providerSchema);

type ProviderFormValues = z.input<typeof providerEditorSchema>;

export function providerFormValues(
  provider: ProviderConfig,
): ProviderFormValues {
  return {
    ...provider,
    credentials: provider.credentials.map((credential) => ({
      ...credential,
      rowId: credential.id,
    })),
  };
}

export function newCredential(): ProviderFormValues["credentials"][number] {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    id: `credential-${rowId.slice(0, 6)}`,
    auth: { type: "api_key", api_key: "" },
    priority: 50,
    disabled: false,
  };
}

export function newProvider(): ProviderFormValues {
  return {
    type: "ai_gateway",
    id: "",
    base_url: "",
    models: [],
    credentials: [
      {
        rowId: "primary",
        id: "primary",
        auth: { type: "api_key", api_key: "" },
        priority: 100,
        disabled: false,
      },
    ],
    disabled: false,
    priority: 100,
    supports_websocket: false,
    supports_web_search: false,
    supports_context_management: false,
  };
}
export const providerFormOptions = formOptions({
  defaultValues: newProvider(),
  validators: { onSubmit: providerEditorSchema, onBlur: providerEditorSchema },
});
