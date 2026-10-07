/** Explicit wire metadata only; no model defaults or token-based inference. */
export interface ReasoningMetadata {
  effort?: string | undefined;
  mode?: string | undefined;
  budget_tokens?: number | undefined;
}

export interface InferenceMetadata {
  model?: string | undefined;
  reasoning?: ReasoningMetadata | undefined;
}

export interface UpstreamObservation {
  request: InferenceMetadata;
  response: InferenceMetadata;
}

export type MetadataComparison = "match" | "mismatch" | "unknown";

export const REASONING_METADATA_FIELDS = [
  "effort",
  "mode",
  "budget_tokens",
] as const satisfies readonly (keyof ReasoningMetadata)[];

export interface MetadataDifference {
  field: "model" | keyof ReasoningMetadata;
  requested: string | number;
  returned: string | number;
}

export interface UpstreamComparison {
  model: MetadataComparison;
  reasoning: MetadataComparison;
  differences: MetadataDifference[];
}

/** Summary and field differences share one comparison, including unknown values. */
export function compareUpstream(
  observation: UpstreamObservation | undefined,
): UpstreamComparison {
  const request = observation?.request;
  const response = observation?.response;
  const differences: MetadataDifference[] = [];
  const compare = (
    field: MetadataDifference["field"],
    requested: string | number | undefined,
    returned: string | number | undefined,
  ): MetadataComparison => {
    if (requested === undefined || returned === undefined) return "unknown";
    const returnedName =
      field === "model" && typeof returned === "string"
        ? returned.slice(returned.lastIndexOf("/") + 1)
        : returned;
    if (returnedName === "") return "unknown";
    if (requested === returnedName) return "match";
    differences.push({ field, requested, returned });
    return "mismatch";
  };
  const model = compare(
    "model",
    request?.model || undefined,
    response?.model || undefined,
  );
  const reasoningFields = REASONING_METADATA_FIELDS.filter(
    (field) => request?.reasoning?.[field] !== undefined,
  );
  let reasoning: MetadataComparison = reasoningFields.length
    ? "match"
    : "unknown";
  for (const field of reasoningFields) {
    const result = compare(
      field,
      request?.reasoning?.[field],
      response?.reasoning?.[field],
    );
    if (
      result === "mismatch" ||
      (result === "unknown" && reasoning !== "mismatch")
    ) {
      reasoning = result;
    }
  }
  return { model, reasoning, differences };
}
