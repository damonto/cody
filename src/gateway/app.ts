import { Hono } from "hono";
import { handleModels } from "./catalog/models.ts";
import {
  gatewayHandler,
  gatewayNotFound,
  type GatewayBindings,
  type GatewayRequest,
} from "./handler.ts";
import { handleHealthClear, handleHealthList } from "./health/handlers.ts";
import { handleInference } from "./http/proxy.ts";
import {
  CONTEXT_MANAGEMENT_PATHS,
  type GatewayEndpoint,
  type InferencePath,
} from "./protocol.ts";
import { handleConfiguredWebSearch } from "./search/search.ts";
import { handleContextManagement } from "./sessions/context-management.ts";
import { handleSessions } from "./sessions/handlers.ts";
import { handleResponsesWebSocket } from "./websocket/websocket.ts";

export const gatewayRoutes = new Hono<GatewayBindings>();

type Handler = Parameters<typeof gatewayHandler>[2];
function endpoint(
  paths: string[],
  name: GatewayEndpoint,
  methods: string[],
  handle: Handler,
): void {
  const handler = gatewayHandler(name, methods, handle);
  // Register supported methods explicitly, then retain dialect-specific 405 responses.
  gatewayRoutes.on(
    name === "responses" ? [...methods, "GET"] : methods,
    paths,
    handler,
  );
  gatewayRoutes.on("ALL", paths, handler);
}
const aliases = (path: string) => [`/${path}`, `/v1/${path}`];

endpoint(aliases("models"), "models", ["GET"], async (r) =>
  handleModels(
    r.request,
    r.env,
    r.config,
    r.client,
    r.requestId,
    r.context,
    r.requestLog,
  ),
);
endpoint(aliases("health"), "health", ["GET"], async (r) =>
  handleHealthList(r.env, r.config, r.client, r.incomingUrl, r.requestLog),
);
endpoint(
  aliases("health/:providerId{[A-Za-z0-9._-]+}/:credentialId{[A-Za-z0-9._-]+}"),
  "health",
  ["DELETE"],
  async (r, c) =>
    handleHealthClear(
      r.env,
      r.config,
      r.client,
      r.incomingUrl,
      c.req.param("providerId")!,
      c.req.param("credentialId"),
      r.requestLog,
    ),
);
endpoint(
  aliases("health/:providerId{[A-Za-z0-9._-]+}"),
  "health",
  ["DELETE"],
  async (r, c) =>
    handleHealthClear(
      r.env,
      r.config,
      r.client,
      r.incomingUrl,
      c.req.param("providerId")!,
      undefined,
      r.requestLog,
    ),
);
endpoint(aliases("sessions"), "sessions", ["GET", "DELETE"], async (r) =>
  handleSessions(
    r.request,
    r.env,
    r.client,
    r.incomingUrl,
    { action: "collection" },
    r.requestLog,
  ),
);
endpoint(aliases("sessions/*"), "sessions", ["DELETE"], async (r) => {
  // Decode exactly once in the session handler, including malformed suffixes.
  const prefix = r.incomingUrl.pathname.startsWith("/v1/")
    ? "/v1/sessions/"
    : "/sessions/";
  return handleSessions(
    r.request,
    r.env,
    r.client,
    r.incomingUrl,
    {
      action: "clear",
      encodedSessionId: r.incomingUrl.pathname.slice(prefix.length),
    },
    r.requestLog,
  );
});

async function inference(
  path: InferencePath,
  r: GatewayRequest,
): Promise<Response> {
  if (path === "alpha/search" && r.config.web_search.mode !== "proxy") {
    return handleConfiguredWebSearch(
      r.request,
      r.config,
      r.client,
      r.requestLog,
    );
  }
  if (r.websocketRequest) {
    return handleResponsesWebSocket(
      r.request,
      r.env,
      r.config,
      r.client,
      r.requestId,
      r.requestLog,
    );
  }
  return handleInference(
    r.request,
    r.env,
    r.config,
    r.client,
    path,
    r.requestId,
    r.context,
    {},
    r.requestLog,
    r.meter,
  );
}
for (const path of [
  "responses",
  "responses/compact",
  "alpha/search",
  "chat/completions",
  "images/generations",
  "images/edits",
] as const) {
  endpoint(aliases(path), path, ["POST"], (r) => inference(path, r));
}
for (const path of ["messages", "messages/count_tokens"] as const) {
  endpoint([`/v1/${path}`], path, ["POST"], (r) => inference(path, r));
}
for (const path of CONTEXT_MANAGEMENT_PATHS) {
  endpoint(aliases(path), path, ["POST"], async (r) =>
    handleContextManagement(
      r.request,
      r.env,
      r.config,
      r.client,
      path,
      r.requestId,
      r.requestLog,
      r.context,
    ),
  );
}

// API namespaces must never fall through to the console's SPA asset fallback.
gatewayRoutes.on(
  "ALL",
  [
    "/v1",
    "/v1/*",
    "/responses/*",
    "/alpha/*",
    "/chat/*",
    "/images/*",
    "/models/*",
    "/health/*",
    "/sessions/*",
    "/messages",
    "/messages/*",
  ],
  gatewayNotFound,
);

export const gatewayApp = new Hono<GatewayBindings>()
  .route("/", gatewayRoutes)
  .all("*", gatewayNotFound);
