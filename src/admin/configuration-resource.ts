import type { Context } from "hono";
import type { ConfigurationOperation } from "../control/unit-of-work.ts";
import type { AdminContext } from "./context.ts";

/** HTTP identity belongs at the transport boundary, not in application services. */
export function operation(
  c: Context<AdminContext>,
  input: { version: number; operation_id: string },
): ConfigurationOperation {
  return {
    version: input.version,
    operation_id: input.operation_id,
    actor: c.get("actor"),
    request: { method: c.req.method, path: new URL(c.req.url).pathname, input },
  };
}
