import { z } from "zod";

/** Verification URLs are shown only in the authenticated account console. */
export const googleVerificationUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    [
      "accounts.google.com",
      "myaccount.google.com",
      "support.google.com",
    ].includes(url.hostname)
  );
});

export const antigravityVerificationSchema = z.object({
  reason: z.enum(["RESTRICTED_AGE", "VALIDATION_REQUIRED"]),
  message: z.string(),
  url: googleVerificationUrlSchema.nullable(),
  learn_more_url: googleVerificationUrlSchema.nullable(),
});
export type AntigravityVerification = z.output<
  typeof antigravityVerificationSchema
>;
