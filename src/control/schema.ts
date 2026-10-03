import { z } from "zod";
import { tokenCountSchema } from "../billing/schema.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";

export const configurationViewSchema = z.object({
  version: tokenCountSchema,
  config: maskedConfigurationSchema,
});
export type ConfigurationView = z.output<typeof configurationViewSchema>;

export const revisionSchema = z.object({
  id: tokenCountSchema.positive(),
  created_at: tokenCountSchema,
  actor: z.string(),
  source_revision: tokenCountSchema.positive().nullable(),
});
