import { z } from "zod";
import { ProviderRequestError } from "../errors.ts";
import {
  antigravityFamilyModels,
  type AntigravityThinkingLevel,
} from "../../shared/antigravity-models.ts";

const effortSchema = z.enum([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const thinkingTypeSchema = z.enum(["disabled", "enabled", "adaptive", "auto"]);
const budgetSchema = z.number().int().nonnegative();
const objectSchema = z.record(z.string(), z.unknown());
const efforts: Record<
  Exclude<z.infer<typeof effortSchema>, "none" | "auto">,
  { level: AntigravityThinkingLevel; budget: number }
> = {
  minimal: { level: "low", budget: 1024 },
  low: { level: "low", budget: 2048 },
  medium: { level: "medium", budget: 8192 },
  high: { level: "high", budget: 16384 },
  xhigh: { level: "high", budget: 24576 },
  max: { level: "high", budget: 24576 },
};

type ThinkingConfiguration =
  | { mode: "unspecified" }
  | { mode: "disabled" }
  | { mode: "auto" }
  | { mode: "enabled" }
  | { mode: "level"; level: AntigravityThinkingLevel; budget: number }
  | { mode: "budget"; budget: number };

export interface AntigravityReasoning {
  configuration: ThinkingConfiguration;
  interleaved: boolean;
}

type NativeThinkingConfig =
  | { thinkingBudget: number; includeThoughts: boolean }
  | { thinkingLevel: AntigravityThinkingLevel; includeThoughts: boolean };

function object(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success)
    throw new ProviderRequestError(`${field} must be an object`);
  return parsed.data;
}

export function antigravityReasoning(
  payload: Record<string, unknown>,
): AntigravityReasoning {
  const thinking = object(payload.thinking, "thinking");
  const reasoning = object(payload.reasoning, "reasoning");
  const outputConfig = object(payload.output_config, "output_config");
  const requested = reasoning.effort ?? outputConfig.effort;
  if (requested != null && typeof requested !== "string")
    throw new ProviderRequestError("reasoning effort must be a string");
  const effort = effortSchema.optional().safeParse(requested ?? undefined);
  if (!effort.success)
    throw new ProviderRequestError("Unsupported reasoning effort");
  const budget = budgetSchema.optional().safeParse(thinking.budget_tokens);
  if (!budget.success)
    throw new ProviderRequestError(
      "thinking.budget_tokens must be a non-negative integer",
    );
  const type = thinkingTypeSchema.optional().safeParse(thinking.type);
  if (!type.success)
    throw new ProviderRequestError("Unsupported thinking type");

  let configuration: ThinkingConfiguration;
  if (type.data === "disabled" || effort.data === "none")
    configuration = { mode: "disabled" };
  else if (budget.data !== undefined)
    configuration = { mode: "budget", budget: budget.data };
  else if (effort.data === "auto") configuration = { mode: "auto" };
  else if (effort.data !== undefined)
    configuration = { mode: "level", ...efforts[effort.data] };
  else if (type.data === "adaptive" || type.data === "auto")
    configuration = { mode: "auto" };
  else
    configuration = {
      mode: type.data === "enabled" ? "enabled" : "unspecified",
    };
  return {
    configuration,
    interleaved: type.data !== undefined && configuration.mode !== "disabled",
  };
}

function thinkingLevel(
  configuration: ThinkingConfiguration,
): AntigravityThinkingLevel {
  switch (configuration.mode) {
    case "disabled":
      return "low";
    case "level":
      return configuration.level;
    case "budget":
      return configuration.budget <= 1024
        ? "low"
        : configuration.budget <= 8192
          ? "medium"
          : "high";
    default:
      return "high";
  }
}

/** Translate normalized intent once, retaining provider-specific native constraints. */
export function antigravityThinkingConfig(
  { configuration }: AntigravityReasoning,
  model: string,
  maxOutputTokens?: number,
): NativeThinkingConfig | undefined {
  if (configuration.mode === "unspecified") return undefined;
  const claude = model.toLowerCase().includes("claude");
  const geminiLevel = /^gemini-(?:3[.-]|pro-agent)/i.test(model);
  if (configuration.mode === "disabled")
    return claude ? undefined : { thinkingBudget: 0, includeThoughts: false };
  if (configuration.mode === "level" && geminiLevel) {
    const level =
      /^gemini-3-pro(?:$|-(?:low|high)$)/i.test(model) &&
      configuration.level === "medium"
        ? "high"
        : configuration.level;
    return { thinkingLevel: level, includeThoughts: true };
  }
  let budget: number;
  if (configuration.mode === "auto") budget = -1;
  else if (configuration.mode === "enabled") budget = geminiLevel ? -1 : 8192;
  else budget = configuration.budget;
  // Never increase the client's output limit to accommodate Claude thinking.
  if (claude && maxOutputTokens !== undefined && budget >= maxOutputTokens)
    budget = maxOutputTokens - 1;
  if (claude && budget !== -1 && budget < 1024) return undefined;
  return { thinkingBudget: budget, includeThoughts: true };
}

export function resolveAntigravityModel(
  models: readonly string[],
  model: string,
  payload: Record<string, unknown> = {},
): string {
  const variants = antigravityFamilyModels(models, model);
  if (!variants.length) return model;
  const level = thinkingLevel(antigravityReasoning(payload).configuration);
  const selected = `${model}-${level}`;
  if (!variants.includes(selected))
    throw new ProviderRequestError(
      `${model} does not have the ${level} thinking level enabled`,
      400,
      "unsupported_reasoning_effort",
    );
  return selected;
}
