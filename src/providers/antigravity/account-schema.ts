import { antigravityVerificationSchema } from "../../shared/antigravity-verification.ts";
import { z } from "zod";

export const antigravityCredentialSchema = z.object({
  token: z.string().min(1),
  project_id: z.string().min(1),
});

export const projectInitializationViewSchema = z
  .object({
    status: z.enum(["pending", "error"]),
    next_retry_at: z.number().nullable(),
    error: z.string().nullable(),
    verification: z.array(antigravityVerificationSchema).optional(),
  })
  .nullable()
  .optional();
