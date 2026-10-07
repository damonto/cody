import { ApiProtocol } from "../gateway/protocol-values.ts";
import type {
  InferenceMetadata,
  ReasoningMetadata,
} from "../shared/upstream-observation.ts";
import { record } from "./usage.ts";

// Discard oversized values instead of comparing truncated names as equal.
export function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256
    ? value
    : undefined;
}

export function reasoningMetadata(input: {
  effort?: unknown;
  mode?: unknown;
  budget_tokens?: unknown;
}): ReasoningMetadata | undefined {
  const result: ReasoningMetadata = {};
  const level = metadataString(input.effort);
  const type = metadataString(input.mode);
  const budget = input.budget_tokens;
  if (level !== undefined) result.effort = level;
  if (type !== undefined) result.mode = type;
  if (
    typeof budget === "number" &&
    Number.isSafeInteger(budget) &&
    budget >= -1
  )
    result.budget_tokens = budget;
  return Object.keys(result).length ? result : undefined;
}

export function inferenceMetadata(
  value: unknown,
  protocol: ApiProtocol,
): InferenceMetadata {
  const payload = record(value);
  const result: InferenceMetadata = {};
  const model = metadataString(payload?.model);
  if (model !== undefined) result.model = model;
  const thinking = record(payload?.thinking);
  const reasoning = reasoningMetadata({
    effort:
      protocol === ApiProtocol.Anthropic
        ? record(payload?.output_config)?.effort
        : (record(payload?.reasoning)?.effort ?? payload?.reasoning_effort),
    mode: thinking?.type,
    budget_tokens: thinking?.budget_tokens,
  });
  if (reasoning) result.reasoning = reasoning;
  return result;
}

export function responseMetadata(
  value: unknown,
  protocol: ApiProtocol,
): InferenceMetadata {
  const payload = record(value);
  return inferenceMetadata(
    record(payload?.response) ?? record(payload?.message) ?? payload,
    protocol,
  );
}

const terminalResponseEvents = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "message_stop",
  "image_generation.completed",
  "image_edit.completed",
]);

export function isTerminalResponse(value: unknown, event = ""): boolean {
  const payload = record(value);
  const type =
    typeof payload?.type === "string" && payload.type ? payload.type : event;
  return (
    terminalResponseEvents.has(type) ||
    (Array.isArray(payload?.choices) &&
      payload.choices.some((choice) => record(choice)?.finish_reason))
  );
}

export type UpstreamMetadataObserver = (
  metadata: InferenceMetadata,
  terminal?: boolean,
) => void;

/** Metadata observation must never interrupt provider response conversion. */
export function notifyUpstreamMetadata(
  observer: UpstreamMetadataObserver | undefined,
  metadata: InferenceMetadata,
  terminal = false,
): void {
  try {
    observer?.(metadata, terminal);
  } catch {
    // Observation is best effort; the wire response remains authoritative.
  }
}
