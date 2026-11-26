import { codexDefaultInstructions } from "./codex/default-instructions.ts";
import {
  CODEX_INPUT_MODALITIES,
  type ModelMetadata,
  modelPrioritySchema,
} from "./metadata.ts";
import {
  isObject,
  type JsonObject,
  stringValue,
  type UpstreamModel,
} from "./upstream.ts";

export interface ClientModel {
  id: string;
  upstream: UpstreamModel;
  metadata: ModelMetadata | undefined;
}

const effortDescriptions = new Map([
  ["low", "Fast responses with lighter reasoning"],
  ["medium", "Balances speed and reasoning depth"],
  ["high", "Greater reasoning depth for complex problems"],
  ["xhigh", "Extended reasoning for difficult tasks"],
  ["max", "Maximum reasoning for demanding tasks"],
  ["ultra", "Highest reasoning effort for long-running tasks"],
]);
export const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
const hiddenCodexModels = new Set([
  CODEX_AUTO_REVIEW_MODEL,
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
]);

const codexTemplate = {
  shell_type: "shell_command",
  supported_in_api: true,
  prefer_websockets: false,
  support_verbosity: false,
  apply_patch_tool_type: "freeform",
  supports_parallel_tool_calls: true,
  web_search_tool_type: "text",
  truncation_policy: { mode: "tokens", limit: 10_000 },
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
};

function tokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

interface ReasoningLevel {
  effort: string;
  details?: JsonObject;
}

function reasoningLevels({
  upstream: { raw, codexInfo },
  metadata,
}: ClientModel): ReasoningLevel[] {
  const nativeLevels = codexInfo?.supported_reasoning_levels;
  const levels = Array.isArray(nativeLevels)
    ? nativeLevels
    : raw.supported_reasoning_levels;
  if (Array.isArray(levels)) {
    const parsed = levels.flatMap((entry: unknown): ReasoningLevel[] => {
      if (typeof entry === "string" && entry) return [{ effort: entry }];
      if (isObject(entry) && typeof entry.effort === "string" && entry.effort)
        return [{ effort: entry.effort, details: entry }];
      return [];
    });
    if (parsed.length > 0 || levels.length === 0) return parsed;
  }
  if (raw.supports_thinking === false) return [];
  const configured = metadata?.supported_reasoning_levels;
  if (configured?.length) return configured.map((effort) => ({ effort }));
  return raw.supports_thinking === true
    ? ["low", "medium", "high"].map((effort) => ({ effort }))
    : [];
}

function modelInputModalities({
  upstream: { raw, codexInfo },
  metadata,
}: ClientModel): unknown[] | undefined {
  if (Array.isArray(codexInfo?.input_modalities))
    return codexInfo.input_modalities;
  if (Array.isArray(raw.input_modalities)) return raw.input_modalities;
  return metadata?.input_modalities;
}

export function codexModelInfo(entry: ClientModel): JsonObject {
  const {
    id,
    upstream: { raw, codexInfo },
    metadata,
  } = entry;
  const source = codexInfo ?? raw;
  const reasoning = reasoningLevels(entry).map(({ effort, details }) => ({
    ...details,
    effort,
    description:
      stringValue(details?.description) ??
      effortDescriptions.get(effort) ??
      effort,
  }));
  const defaultReasoning =
    source.default_reasoning_level === null
      ? null
      : (stringValue(source.default_reasoning_level) ??
        reasoning.find(({ effort }) => effort === "medium")?.effort ??
        reasoning[0]?.effort);
  const modalities = modelInputModalities(entry) ?? ["text"];
  const priority =
    typeof source.priority === "number"
      ? modelPrioritySchema.safeParse(source.priority)
      : undefined;
  const upstreamInputLimit = tokenLimit(raw.max_input_tokens);
  const upstreamContext =
    tokenLimit(source.context_window) ?? upstreamInputLimit;
  const upstreamMaxContext =
    tokenLimit(source.max_context_window) ?? upstreamInputLimit;
  let context = upstreamContext;
  let maxContext = upstreamMaxContext;
  if (metadata) {
    // Keep a limit supplied upstream when the corresponding local fallback would contradict it.
    context ??= Math.min(
      metadata.context_window,
      upstreamMaxContext ?? Infinity,
    );
    maxContext ??= Math.max(metadata.max_context_window, context);
  }
  const messages = isObject(source.model_messages) ? source.model_messages : {};
  const tokenBudget = messages.token_budget;
  const description =
    source.description === null
      ? null
      : (stringValue(source.description) ?? metadata?.description ?? null);

  return {
    ...codexTemplate,
    visibility: hiddenCodexModels.has(id) ? "hide" : "list",
    ...codexInfo,
    slug: id,
    display_name:
      stringValue(source.display_name) ?? metadata?.display_name ?? id,
    description,
    priority: priority?.success ? priority.data : (metadata?.priority ?? 99),
    input_modalities: modalities.filter((modality) =>
      CODEX_INPUT_MODALITIES.some((supported) => supported === modality),
    ),
    context_window: context,
    max_context_window: maxContext,
    default_reasoning_level: defaultReasoning,
    supported_reasoning_levels: reasoning,
    supports_experimental_context: false,
    model_messages: {
      ...messages,
      instructions_template:
        stringValue(messages.instructions_template) ??
        stringValue(source.base_instructions) ??
        codexDefaultInstructions,
      // The gateway does not serve the native history/notes endpoints.
      ...(isObject(tokenBudget)
        ? {
            token_budget: {
              ...tokenBudget,
              enabled: false,
              use_history_notes_extension: false,
            },
          }
        : {}),
    },
  };
}

const anthropicEffortLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const ANTHROPIC_MODEL_CREATED_AT = "2024-01-01T00:00:00Z";
// Claude Code defaults for models without published limits.
const ANTHROPIC_MODEL_MAX_TOKENS = 32_000;
const ANTHROPIC_MODEL_DEFAULT_CONTEXT_TOKENS = 200_000;
const ANTHROPIC_1M_CONTEXT_TOKENS = 1_000_000;
const anthropicCapabilities = {
  batch: { supported: true },
  citations: { supported: true },
  code_execution: { supported: false },
  context_management: {
    supported: false,
    clear_thinking_20251015: { supported: false },
    clear_tool_uses_20250919: { supported: false },
    compact_20260112: { supported: false },
  },
  structured_outputs: { supported: true },
};

// Only the known fields are traversed. A disabled parent keeps missing children disabled.
function fillCapabilities(
  defaults: JsonObject,
  upstream: JsonObject,
  parentDisabled = false,
): JsonObject {
  const disabled = parentDisabled || upstream.supported === false;
  const result = { ...upstream };
  for (const [key, fallback] of Object.entries(defaults)) {
    const supplied = result[key];
    if (isObject(fallback) && (supplied === undefined || isObject(supplied))) {
      result[key] = fillCapabilities(fallback, supplied ?? {}, disabled);
    } else if (supplied === undefined) {
      result[key] = key === "supported" && disabled ? false : fallback;
    }
  }
  return result;
}

export function anthropicModelInfo(
  entry: ClientModel,
): JsonObject & { id: string } {
  const {
    id,
    upstream: { id: upstreamId, raw: model, codexInfo },
    metadata,
  } = entry;
  const modalities = modelInputModalities(entry) ?? [];
  const efforts = new Set(reasoningLevels(entry).map(({ effort }) => effort));
  const effortLevels = Object.fromEntries(
    anthropicEffortLevels.map((effort) => [
      effort,
      { supported: efforts.has(effort) },
    ]),
  );
  const upstreamCapabilities = isObject(model.capabilities)
    ? model.capabilities
    : {};
  const supportsThinking = efforts.size > 0;
  const maxInputTokens =
    model.max_input_tokens === null
      ? null
      : (tokenLimit(model.max_input_tokens) ??
        tokenLimit(codexInfo?.max_context_window) ??
        tokenLimit(model.max_context_window) ??
        tokenLimit(codexInfo?.context_window) ??
        tokenLimit(model.context_window) ??
        metadata?.max_context_window ??
        ANTHROPIC_MODEL_DEFAULT_CONTEXT_TOKENS);
  const supports1m =
    maxInputTokens !== null && maxInputTokens >= ANTHROPIC_1M_CONTEXT_TOKENS;
  const name = stringValue(model.name);
  const capabilityDefaults = {
    ...anthropicCapabilities,
    effort: {
      supported: anthropicEffortLevels.some((effort) => efforts.has(effort)),
      ...effortLevels,
    },
    image_input: { supported: modalities.includes("image") },
    pdf_input: { supported: modalities.includes("pdf") },
    thinking: {
      supported: supportsThinking,
      types: {
        adaptive: { supported: supportsThinking },
        enabled: { supported: supportsThinking },
      },
    },
  };

  return {
    ...(model.type === "model" ? model : {}),
    id,
    // Claude Desktop uses name as the identifier when it is supplied.
    name: name === upstreamId ? id : (name ?? id),
    type: "model",
    display_name:
      stringValue(model.display_name) ??
      stringValue(codexInfo?.display_name) ??
      metadata?.display_name ??
      id,
    supports1m:
      typeof model.supports1m === "boolean" ? model.supports1m : supports1m,
    prefer1m: typeof model.prefer1m === "boolean" ? model.prefer1m : supports1m,
    created_at: stringValue(model.created_at) ?? ANTHROPIC_MODEL_CREATED_AT,
    max_input_tokens: maxInputTokens,
    max_tokens:
      model.max_tokens === null
        ? null
        : (tokenLimit(model.max_tokens) ??
          tokenLimit(model.max_output_tokens) ??
          tokenLimit(codexInfo?.max_output_tokens) ??
          ANTHROPIC_MODEL_MAX_TOKENS),
    capabilities:
      model.capabilities === null
        ? null
        : fillCapabilities(capabilityDefaults, upstreamCapabilities),
  };
}
