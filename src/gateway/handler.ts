import type { Context, ExecutionContext, Handler } from "hono";
import { ConfigError, loadConfig } from "../config/store.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../config/types.ts";
import {
  configureLogging,
  errorMessage,
  newRequestId,
  RequestLogContext,
} from "../shared/log.ts";
import { durableUsageSink } from "../telemetry/delivery.ts";
import { RequestMeter } from "../telemetry/meter.ts";
import { apiError, bearerToken, findClientApiKey } from "./http/http.ts";
import { requestProtocol, type GatewayEndpoint } from "./protocol.ts";
import type { Bindings } from "../platform/bindings.ts";

export type GatewayBindings = { Bindings: Bindings };
export interface GatewayRequest {
  request: Request;
  env: Bindings;
  config: GatewayConfig;
  client: ClientApiKeyConfig;
  incomingUrl: URL;
  requestId: string;
  context: ExecutionContext;
  websocketRequest: boolean;
  requestLog: RequestLogContext;
  meter: RequestMeter | undefined;
}

type EndpointHandler = (
  request: GatewayRequest,
  context: Context<GatewayBindings>,
) => Promise<Response>;

/** Shared authentication and observation; request bytes remain owned by the endpoint. */
export function gatewayHandler(
  endpoint: GatewayEndpoint | undefined,
  allowedMethods: readonly string[],
  handle: EndpointHandler,
): Handler<GatewayBindings> {
  return async (hono) => {
    const request = hono.req.raw;
    const env = hono.env;
    const context = hono.executionCtx;
    configureLogging(env.LOG_LEVEL);
    const requestId = newRequestId();
    const incomingUrl = new URL(request.url);
    const protocol = requestProtocol(request, endpoint);
    const websocketRequest =
      endpoint === "responses" &&
      request.method === "GET" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    // WebSocket usage starts with response.create in the Durable Object.
    const usageOutbox = env.USAGE_OUTBOX;
    const meter =
      usageOutbox &&
      request.method === "POST" &&
      (endpoint === "messages" || endpoint === "responses")
        ? new RequestMeter({
            requestId,
            endpoint,
            method: request.method,
            protocol,
            sink: durableUsageSink({ USAGE_OUTBOX: usageOutbox }, requestId),
            executionContext: context,
          })
        : undefined;
    const requestLog = new RequestLogContext(
      requestId,
      request,
      endpoint,
      context,
    );
    if (
      endpoint === "sessions" &&
      incomingUrl.pathname.includes("/sessions/")
    ) {
      const prefix = incomingUrl.pathname.startsWith("/v1/")
        ? "/v1/sessions"
        : "/sessions";
      requestLog.set({ path: `${prefix}/{session_id}` });
    }
    const finish = (response: Response): Response => {
      requestLog.complete(response);
      return meter?.response(response) ?? response;
    };
    requestLog.registerSensitiveValues([
      bearerToken(request),
      request.headers.get("x-api-key"),
    ]);

    if (!endpoint) {
      meter?.diagnostic("route_not_found");
      requestLog.warn({ outcome: "route_not_found" });
      return finish(
        apiError(protocol, 404, "Not found", {
          code: "not_found",
          requestId,
        }),
      );
    }
    if (!websocketRequest && !allowedMethods.includes(request.method)) {
      meter?.diagnostic("method_rejected");
      requestLog.warn({
        outcome: "method_rejected",
        expected_methods: allowedMethods,
      });
      return finish(
        apiError(
          protocol,
          405,
          `Only ${allowedMethods.join(" or ")} is allowed for this endpoint`,
          { requestId },
        ),
      );
    }

    let config;
    try {
      config = await loadConfig(env, requestLog);
      meter?.configure(config);
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message
          : "configuration is unavailable";
      meter?.diagnostic("configuration_error");
      requestLog.error({
        outcome: "configuration_error",
        error: errorMessage(error),
      });
      return finish(
        apiError(protocol, 500, message, {
          type: "server_error",
          code: "configuration_error",
          requestId,
        }),
      );
    }

    const client = await findClientApiKey(request, config.api_keys);
    if (!client) {
      meter?.diagnostic("authentication_rejected");
      requestLog.warn({
        outcome: "authentication_rejected",
        authentication: "rejected",
      });
      return finish(
        apiError(protocol, 401, "Invalid API key", {
          code: "invalid_api_key",
          requestId,
        }),
      );
    }

    requestLog.registerSensitiveValues([client.api_key]);
    meter?.authenticate(client.id);

    requestLog.set({
      authentication: "accepted",
      client_id: client.id,
      allowed_providers: [...client.providers],
    });

    try {
      const response = await handle(
        {
          request,
          env,
          config,
          client,
          incomingUrl,
          requestId,
          context,
          websocketRequest,
          requestLog,
          meter,
        },
        hono,
      );
      return finish(response);
    } catch (error) {
      meter?.diagnostic("gateway_error");
      requestLog.error({
        outcome: "gateway_error",
        error: errorMessage(error),
      });
      return finish(
        apiError(protocol, 500, "The gateway failed to process the request", {
          type: "server_error",
          code: "gateway_error",
          requestId,
        }),
      );
    }
  };
}

export const gatewayNotFound = gatewayHandler(
  undefined,
  [],
  async () => new Response(null, { status: 404 }),
);
