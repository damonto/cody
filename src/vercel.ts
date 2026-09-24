import { fileURLToPath, URL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
import {
  createRuntime,
  type StandardRuntime,
} from "./platform/standard/runtime.ts";
import { errorMessage, logError } from "./shared/log.ts";

let initialized: Promise<StandardRuntime> | undefined;

function runtime(): Promise<StandardRuntime> {
  initialized ??= createRuntime({
    target: "vercel",
    root: fileURLToPath(new URL("./", import.meta.url)),
    waitUntil,
    onPool: attachDatabasePool,
  }).catch((error: unknown) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

export default getRequestListener(
  async (request) => (await runtime()).fetch(request),
  {
    overrideGlobalObjects: false,
    errorHandler: (error) => {
      logError("vercel.request.failed", { error: errorMessage(error) });
      return Response.json(
        {
          error:
            "The gateway could not initialize. Check the runtime settings and database migrations.",
        },
        { status: 503 },
      );
    },
  },
);
