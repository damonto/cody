import { z } from "zod";
import {
  aiGatewayProviderSchema,
  codexProviderFormSchema,
  claudeProviderFormSchema,
  xaiProviderFormSchema,
  clientSchema,
  proxyGroupSchema,
  proxyNodeSchema,
  socksProxySchema,
  credentialSchema,
  oauthCredentialSchema,
  nameSchema,
} from "../config/schema.ts";
export const providerInputSchema = aiGatewayProviderSchema
  .omit({ id: true })
  .extend({ name: nameSchema });
export const clientInputSchema = clientSchema
  .omit({ id: true })
  .extend({ name: nameSchema });
export const groupInputSchema = proxyGroupSchema
  .omit({ id: true })
  .extend({ name: nameSchema });
export const nodeInputSchema = socksProxySchema.safeExtend({
  name: nameSchema,
  priority: proxyNodeSchema.shape.priority,
  disabled: proxyNodeSchema.shape.disabled,
});
export const credentialInputSchema = z.union([
  credentialSchema.omit({ id: true }).extend({ name: nameSchema }),
  oauthCredentialSchema.omit({ id: true }).extend({ name: nameSchema }),
]);
export const nativeTypeSchema = z.enum(["codex", "claude", "xai"]);
export const nativeSettingsSchema = z.discriminatedUnion("type", [
  codexProviderFormSchema.omit({ id: true, credentials: true }),
  claudeProviderFormSchema.omit({ id: true, credentials: true }),
  xaiProviderFormSchema.omit({ id: true, credentials: true }),
]);
