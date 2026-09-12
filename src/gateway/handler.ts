import type { Context, ExecutionContext, Handler } from "hono";
import { ConfigError, loadConfig } from "../config/store.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../config/types.ts";
import { RequestMeter } from "../telemetry/meter.ts";
import { durableUsageSink } from "../telemetry/delivery.ts";
import { apiError, bearerToken, findClientApiKey } from "./http/http.ts";
import {
  errorMessage,
  configureLogging,
  newRequestId,
  RequestLogContext,
} from "../shared/log.ts";
import { requestProtocol, type GatewayEndpoint } from "./protocol.ts";

export type GatewayBindings = { Bindings: Env };
export interface GatewayRequest {
  request: Request;
  env: Env;
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
    const meter =
      env.USAGE_OUTBOX && (endpoint === "messages" || endpoint === "responses")
        ? new RequestMeter({
            requestId,
            endpoint,
            method: request.method,
            protocol,
            sink: durableUsageSink(env, requestId),
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
    const websocketRequest =
      endpoint === "responses" &&
      request.method === "GET" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
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
      client_key_id: client.id,
      allowed_services: [...client.services],
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
