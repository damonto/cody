import {
  antigravityModelGroups,
  antigravityVariant,
} from "../../shared/antigravity-models.ts";

interface CatalogModel {
  id: string;
  raw: Record<string, unknown>;
}

/** Keep physical entries for explicit aliases; the gateway hides their automatic names. */
export function antigravityCatalogModels(
  models: CatalogModel[],
  configured: readonly string[],
): CatalogModel[] {
  const configuredIds = new Set(configured);
  const selected = models.filter((model) => configuredIds.has(model.id));
  const byId = new Map(selected.map((model) => [model.id, model]));
  const families: CatalogModel[] = [];
  for (const [id, variants] of antigravityModelGroups(configured)) {
    if (configuredIds.has(id)) continue;
    const entries = variants.flatMap((variant) => {
      const entry = byId.get(variant);
      return entry ? [entry] : [];
    });
    if (!entries.length) continue;
    const levels = entries.flatMap((entry) => {
      const variant = antigravityVariant(entry.id);
      return variant ? [variant.level] : [];
    });
    // Missing metadata for an enabled variant must not inflate shared capabilities.
    const complete = entries.length === variants.length;
    const limit = (field: string) => {
      if (!complete) return null;
      const values = entries.map((entry) => entry.raw[field]);
      return values.every(
        (value): value is number => typeof value === "number" && value > 0,
      )
        ? Math.min(...values)
        : null;
    };
    const modalities = entries.map((entry) => entry.raw.input_modalities);
    families.push({
      id,
      raw: {
        id,
        object: "model",
        owned_by: "antigravity",
        display_name: id,
        context_window: limit("context_window"),
        max_output_tokens: limit("max_output_tokens"),
        supports_thinking:
          complete &&
          entries.every((entry) => entry.raw.supports_thinking === true),
        thinking_levels: levels,
        default_thinking_level: levels.includes("high") ? "high" : null,
        input_modalities: ["text", "image", "audio", "video"].filter(
          (value) =>
            complete &&
            modalities.every(
              (items) => Array.isArray(items) && items.includes(value),
            ),
        ),
      },
    });
  }
  return [...selected, ...families];
}
