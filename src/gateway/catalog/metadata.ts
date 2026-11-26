import { z } from "zod";
import models from "./models.json" with { type: "json" };

export const CODEX_INPUT_MODALITIES = ["text", "image", "audio"] as const;
const reasoningLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export const modelPrioritySchema = z.int32();

const modelSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    display_name: z.string().min(1),
    description: z.string(),
    priority: modelPrioritySchema,
    input_modalities: z
      .array(z.enum([...CODEX_INPUT_MODALITIES, "pdf"]))
      .min(1),
    context_window: z.int().positive(),
    max_context_window: z.int().positive(),
    supported_reasoning_levels: z.array(z.enum(reasoningLevels)),
  })
  .refine((model) => model.max_context_window >= model.context_window, {
    path: ["max_context_window"],
    message:
      "Maximum context window must be at least the default context window",
  });

export const modelCatalogSchema = z.strictObject({
  models: z
    .array(modelSchema)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      { message: "Model IDs must be unique" },
    ),
});
export type ModelMetadata = z.output<typeof modelSchema>;

const catalog = modelCatalogSchema.parse(models);
const catalogById = new Map(catalog.models.map((model) => [model.id, model]));
// Bump the version when rendered catalogs change.
export const MODEL_TEMPLATES_CACHE_IDENTITY = JSON.stringify([3, catalog]);

export function modelMetadata(
  id: string,
  upstreamId: string,
): ModelMetadata | undefined {
  return catalogById.get(id) ?? catalogById.get(upstreamId);
}
