type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function codexTurnMetadata(payload: JsonObject): JsonObject | undefined {
  const value = asObject(payload.client_metadata)?.["x-codex-turn-metadata"];
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function contextManagementRequested(payload: JsonObject): boolean {
  return codexTurnMetadata(payload)?.history_ingest_requested === true;
}

export function contextManagementSessionMatches(
  payload: JsonObject,
  sessionId: string | undefined,
): boolean {
  const metadata = asObject(payload.client_metadata);
  return (
    sessionId !== undefined &&
    [metadata?.session_id, codexTurnMetadata(payload)?.session_id].every(
      (value) => value === undefined || value === sessionId,
    )
  );
}

export function parseContextManagementSession(
  text: string,
  headerSessionId: string | null,
): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("request body must be valid JSON");
  }
  const context = asObject(asObject(payload)?.context);
  const sessionId = context?.session_id;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("context.session_id must be a non-empty string");
  }
  if (
    typeof context?.current_agent_name !== "string" ||
    context.current_agent_name.trim() === ""
  ) {
    throw new Error("context.current_agent_name must be a non-empty string");
  }
  if (headerSessionId?.trim() && headerSessionId !== sessionId) {
    throw new Error("session-id must match context.session_id");
  }
  return sessionId;
}
