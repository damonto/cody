import type { InferenceMetadata } from "../../shared/upstream-observation.ts";
import {
  metadataString,
  reasoningMetadata,
} from "../../telemetry/inference-metadata.ts";
import { record } from "../../telemetry/usage.ts";

export function antigravityMetadata(
  model: unknown,
  thinking: unknown,
): InferenceMetadata {
  const result: InferenceMetadata = {};
  const name = metadataString(model);
  if (name !== undefined) result.model = name;
  const config = record(thinking);
  const reasoning = reasoningMetadata({
    effort: config?.thinkingLevel,
    budget_tokens: config?.thinkingBudget,
  });
  if (reasoning) result.reasoning = reasoning;
  return result;
}
