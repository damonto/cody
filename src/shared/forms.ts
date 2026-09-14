import { z } from "zod";
import { nameSchema, routeSchema } from "../config/schema.ts";
export {
  clientSchema as clientFormSchema,
  searchSchema as searchFormSchema,
  draftConfigurationSchema,
} from "../config/schema.ts";
export const routeFormSchema = routeSchema.extend({
  alias: nameSchema,
  providers: z.array(nameSchema),
});
