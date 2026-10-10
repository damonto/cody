import type { ClientApiKeyConfig } from "../../config/types.ts";
import type { RequestLogContext } from "../../shared/log.ts";
import { openAiError } from "../http/http.ts";
import {
  decodeSessionIdPath,
  handleSessionClearAll,
  handleSessionClearOne,
  handleSessionList,
} from "./session-bindings.ts";
import type { Bindings } from "../../platform/bindings.ts";

export type SessionAction =
  { action: "collection" } | { action: "clear"; encodedSessionId: string };

export async function handleSessions(
  request: Request,
  env: Bindings,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  matchedRoute: SessionAction,
  requestLog: RequestLogContext,
): Promise<Response> {
  const models = incomingUrl.searchParams.getAll("model");
  const model = models[0];
  if (
    models.length > 0 &&
    (models.length !== 1 ||
      !model?.trim() ||
      matchedRoute.action !== "clear" ||
      incomingUrl.searchParams.get("release_context_ownership") === "true")
  ) {
    return openAiError(
      400,
      "model must occur once, be non-empty, and requires a single session without ownership release",
      "invalid_request_error",
      "invalid_session_model_query",
    );
  }
  const releaseValues = incomingUrl.searchParams.getAll(
    "release_context_ownership",
  );
  const releaseOwnership = releaseValues[0];
  if (
    releaseValues.length > 0 &&
    (releaseValues.length !== 1 ||
      matchedRoute.action !== "clear" ||
      (releaseOwnership !== "true" && releaseOwnership !== "false"))
  ) {
    requestLog.warn({ outcome: "invalid_session_release_query" });
    return openAiError(
      400,
      "release_context_ownership must occur once, be true or false, and requires a single session",
      "invalid_request_error",
      "invalid_session_release_query",
    );
  }
  if (matchedRoute.action === "collection") {
    return request.method === "GET"
      ? handleSessionList(env, client, incomingUrl, requestLog)
      : handleSessionClearAll(env, client, requestLog);
  }
  const sessionId = decodeSessionIdPath(matchedRoute.encodedSessionId);
  if (!sessionId) {
    requestLog.warn({
      outcome: "invalid_session_id",
      sessions: { action: "clear_one" },
    });
    return openAiError(
      400,
      "session_id must be a non-empty URL-encoded string",
      "invalid_request_error",
      "invalid_session_id",
    );
  }
  return handleSessionClearOne(env, client, sessionId, requestLog, {
    model,
    releaseContextOwnership: releaseOwnership === "true",
  });
}
