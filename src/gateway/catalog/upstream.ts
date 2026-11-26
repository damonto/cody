export type JsonObject = Record<string, unknown>;

export interface UpstreamModel {
  id: string;
  raw: JsonObject;
  codexInfo?: JsonObject;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseUpstreamModels(
  value: unknown,
  fromCodexAdapter: boolean,
): UpstreamModel[] | undefined {
  if (!isObject(value)) return undefined;
  const standard = Array.isArray(value.data);
  const entries: unknown = standard ? value.data : value.models;
  if (!Array.isArray(entries)) return undefined;

  const models: UpstreamModel[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const slug = stringValue(entry.slug);
    const id = standard
      ? (stringValue(entry.id) ?? slug)
      : (slug ?? stringValue(entry.id));
    if (!id) continue;

    const model: UpstreamModel = { id, raw: entry };
    // The native adapter includes its original ModelInfo alongside a standard entry.
    if (fromCodexAdapter && isObject(entry.codex))
      model.codexInfo = entry.codex;
    else if (!standard && slug) model.codexInfo = entry;
    models.push(model);
  }
  return models;
}
