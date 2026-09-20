import { z } from "zod";

export const secretSchema = z
  .string({ error: "must be a non-empty string" })
  .trim()
  .min(1, "must be a non-empty string");
