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
