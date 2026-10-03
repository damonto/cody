import { z } from "zod";
import { configurationOperationSchema } from "./schema.ts";
export {
  providerInputSchema,
  clientInputSchema,
  groupInputSchema,
  nodeInputSchema,
  credentialInputSchema,
  nativeTypeSchema,
  nativeSettingsSchema,
} from "../control/resource-input.ts";
export const resourceIdSchema = z.object({ id: z.uuid() });
export const providerCredentialParams = z.object({
  id: z.uuid(),
  credentialId: z.uuid(),
});
export const nodeParams = z.object({ id: z.uuid(), nodeId: z.uuid() });
export const orderSchema = configurationOperationSchema.extend({
  ids: z.array(z.uuid()),
});
