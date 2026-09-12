import { z } from "zod";
import { nameSchema, routeSchema } from "../config/schema.ts";
export {
  identifierSchema,
  nameSchema,
  baseUrlSchema,
  routeSchema,
  serviceRouteSchema,
  retrySchema,
  credentialSchema,
  serviceSchema as serviceFormSchema,
  clientSchema as clientFormSchema,
  searchSchema as searchFormSchema,
  draftConfigurationSchema,
} from "../config/schema.ts";
export const routeFormSchema = routeSchema.extend({
  alias: nameSchema,
  services: z.array(nameSchema),
});
