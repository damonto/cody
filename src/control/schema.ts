import { z } from "zod";
import { tokenCountSchema } from "../billing/schema.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";

export const draftViewSchema = z.object({
  version: tokenCountSchema,
  published_revision: tokenCountSchema.positive().nullable(),
  config: maskedConfigurationSchema,
  valid: z.boolean(),
  validation_error: z.string().nullable(),
});
export type DraftView = z.output<typeof draftViewSchema>;

export const publisherReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: draftViewSchema }),
  z.object({
    ok: z.literal(false),
    status: z.union([z.literal(400), z.literal(409)]),
    error: z.string(),
  }),
]);
export type PublisherReply = z.output<typeof publisherReplySchema>;

export const revisionSchema = z.object({
  id: tokenCountSchema.positive(),
  created_at: tokenCountSchema,
  published_at: tokenCountSchema.nullable(),
  actor: z.string(),
  status: z.enum(["pending", "published", "superseded"]),
  source_revision: tokenCountSchema.positive().nullable(),
});
