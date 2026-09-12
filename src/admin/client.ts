import { hc } from "hono/client";
import type { AdminApi } from "./app.ts";

// Project references let the console consume the compiled RPC types.
export type AdminClient = ReturnType<typeof hc<AdminApi>>;
export const createAdminClient = (
  ...args: Parameters<typeof hc>
): AdminClient => hc<AdminApi>(...args);
