import { z } from "zod";
import { nameSchema, routeSchema } from "../config/schema.ts";
export {
  clientSchema as clientFormSchema,
  draftConfigurationSchema,
  searchSchema as searchFormSchema,
} from "../config/schema.ts";
export const routeFormSchema = routeSchema.extend({
  alias: nameSchema,
  providers: z.array(nameSchema),
});
