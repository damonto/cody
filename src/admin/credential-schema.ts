import { z } from "zod";
import { secretSchema } from "../shared/secret-schema.ts";
import { SECRET_PLACEHOLDER } from "../shared/secrets.ts";

// This response contract is also used by the console's eager API client.
// Keep it independent of configuration, billing, and reporting schemas.
export const apiKeySchema = z
  .strictObject({ api_key: secretSchema })
  .refine(({ api_key }) => api_key !== SECRET_PLACEHOLDER, {
    message: "Invalid API credential",
  });
