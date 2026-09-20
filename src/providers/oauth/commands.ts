import { z } from "zod";
import { connectionSchema, proxyConfigurationSchema } from "./schema.ts";

const sessionOwner = {
  actor: z.string().min(1),
  session_id: z.uuid(),
};

/** Required fields are checked both at RPC call sites and at the runtime boundary. */
export const accountCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    account_ref: z.uuid(),
    actor: sessionOwner.actor,
    connection: connectionSchema,
  }),
  z.strictObject({
    action: z.enum(["session", "cancel", "retry"]),
    ...sessionOwner,
  }),
  z.strictObject({
    action: z.literal("complete"),
    ...sessionOwner,
    redirect_url: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    action: z.literal("resolve"),
    connection: connectionSchema,
    proxy_configuration: proxyConfigurationSchema,
  }),
  z.strictObject({ action: z.enum(["view", "models", "disconnect"]) }),
  z.strictObject({
    action: z.literal("quota"),
    force: z.boolean().default(false),
  }),
]);

export type AccountCommand = z.input<typeof accountCommandSchema>;
