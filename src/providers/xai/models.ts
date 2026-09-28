import catalog from "../../gateway/catalog/models.json";
import type { AccountModel } from "../oauth/schema.ts";

export function xaiModels(): AccountModel[] {
  return catalog.models
    .filter((model) => model.slug.startsWith("grok-"))
    .map((model) => ({
      id: model.slug,
      display_name: model.display_name,
      input_token_limit: model.context_window,
      output_token_limit: null,
      supports_thinking: model.supported_reasoning_levels.length > 0,
      supports_images: model.input_modalities.includes("image"),
    }));
}
