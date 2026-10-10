import { upstreamErrorCode } from "../../shared/upstream-error.ts";
import { ResponseObserver } from "../../telemetry/response-observer.ts";
import { z } from "zod";
import {
  responseFormat,
  type ResponseObservationFormat,
} from "./response-format.ts";
import { inspectResponsePrefix } from "./response-prefix.ts";
import {
  RETRY_EVENT_TYPE_PATTERN,
  type RetryDiagnostic,
} from "../../shared/retry-diagnostic.ts";
import { MAX_RETRY_RESPONSE_BYTES } from "../../shared/response-limits.ts";

const RETRY_ERROR_INSPECTION_MS = 10_000;

// Only known, empty placeholders may remain buffered. A new field or tool
// item can carry output or start work, so it must commit the stream instead.
const emptyArray = z.tuple([]);
const emptyTextPart = z.strictObject({
  type: z.literal("output_text"),
  text: z.literal(""),
  annotations: emptyArray.optional(),
  logprobs: emptyArray.optional(),
});
const emptyRefusalPart = z.strictObject({
  type: z.literal("refusal"),
  refusal: z.literal(""),
});
const emptySummaryPart = z.strictObject({
  type: z.literal("summary_text"),
  text: z.literal(""),
});
const emptyReasoningPart = z.strictObject({
  type: z.literal("reasoning_text"),
  text: z.literal(""),
});
const emptyMessagePart = z.union([emptyTextPart, emptyRefusalPart]);
const emptyPart = z.union([emptyMessagePart, emptySummaryPart]);
const emptyOutputItem = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("message"),
    id: z.string().optional(),
    role: z.literal("assistant"),
    status: z.literal("in_progress").optional(),
    content: z.array(emptyMessagePart),
  }),
  z.strictObject({
    type: z.literal("reasoning"),
    id: z.string().optional(),
    status: z.literal("in_progress").optional(),
    summary: z.array(emptySummaryPart),
    content: z.array(emptyReasoningPart).optional(),
    encrypted_content: z.literal("").nullish(),
  }),
]);
const responseSchema = z.object({
  status: z.string().optional(),
  output: z.array(z.unknown()).nullish(),
  error: z.unknown().optional(),
  delta: z.unknown().optional(),
  choices: z.unknown().optional(),
  content: z.unknown().optional(),
});
const envelopeSchema = responseSchema.extend({
  type: z.string().optional(),
  response: responseSchema.optional(),
  item: z.unknown().optional(),
  part: z.unknown().optional(),
});
type RetryEnvelope = z.infer<typeof envelopeSchema>;
type FinalRetryDecision =
  | { kind: "forward"; diagnostic: RetryDiagnostic }
  | { kind: "retry"; code: string; diagnostic: RetryDiagnostic };
type RetryDecision = { kind: "inspect" } | FinalRetryDecision;

export interface RetryErrorInspection {
  response: Response;
  errorCode?: string | undefined;
  diagnostic: RetryDiagnostic;
}

interface RetryErrorInspectionOptions {
  maxBytes?: number;
  format?: ResponseObservationFormat;
  /** Observe each parsed event, including events forwarded after preflight. */
  onEvent?: (
    value: unknown,
    event: string,
    replayable: boolean,
  ) => Promise<void>;
}

function hasOutput(output: RetryEnvelope["output"]): boolean {
  return (
    output?.some((item) => !emptyOutputItem.safeParse(item).success) ?? false
  );
}

function isEmptyPreamble(payload: RetryEnvelope, type: string): boolean {
  switch (type) {
    case "response.created":
    case "response.in_progress":
      return payload.response !== undefined;
    case "response.output_item.added":
      return emptyOutputItem.safeParse(payload.item).success;
    case "response.content_part.added":
      return emptyMessagePart.safeParse(payload.part).success;
    case "response.reasoning_summary_part.added":
      return emptySummaryPart.safeParse(payload.part).success;
    default:
      return false;
  }
}

/** Known protocol events may start work even without visible text. */
function commitsProtocolEvent(type: string): boolean {
  if (type === "response.completed" || type === "response.incomplete")
    return true;
  if (type.startsWith("response.") && type.includes("_call.")) return true;
  return [
    "response.output_",
    "response.content_part.",
    "response.reasoning_",
    "response.function_call_",
    "response.custom_tool_call_",
    "response.mcp_list_tools.",
    "content_block_",
    "message_",
    "chat.",
  ].some((prefix) => type.startsWith(prefix));
}

function hasContent(payload: z.infer<typeof responseSchema>): boolean {
  return (
    hasOutput(payload.output) ||
    payload.delta !== undefined ||
    payload.choices !== undefined ||
    payload.content !== undefined
  );
}

/** Recognize errors separately from the decision to commit upstream output. */
function classifyPayload(
  value: unknown,
  event: string,
  codes: readonly string[],
): RetryDecision {
  const parsed = envelopeSchema.safeParse(value);
  const code = upstreamErrorCode(value, event);
  const eventType = parsed.success ? (parsed.data.type ?? event) : event;
  const diagnostic = (reason: RetryDiagnostic["reason"]): RetryDiagnostic => ({
    reason,
    // Keep protocol identifiers, never arbitrary event text or payloads.
    ...(RETRY_EVENT_TYPE_PATTERN.test(eventType)
      ? { event_type: eventType }
      : {}),
    ...(code ? { error_code: code } : {}),
  });
  const forward = (reason: RetryDiagnostic["reason"]): FinalRetryDecision => ({
    kind: "forward",
    diagnostic: diagnostic(reason),
  });
  if (!parsed.success) return forward("invalid_envelope");
  const payload = parsed.data;
  const type = payload.type ?? event;
  const response = payload.response;
  // Check content before accepting a lifecycle preamble. Otherwise an added
  // delta on response.created could be buffered and replayed after a later error.
  if (
    hasContent(payload) ||
    (response && hasContent(response)) ||
    (payload.item !== undefined &&
      !emptyOutputItem.safeParse(payload.item).success) ||
    (payload.part !== undefined && !emptyPart.safeParse(payload.part).success)
  )
    return forward("output_observed");
  // An SSE event name and its JSON type must agree when both are present.
  if (event && payload.type && event !== payload.type)
    return forward("event_type_mismatch");
  const pending =
    [payload.status, response?.status].every(
      (status) =>
        status === undefined || status === "queued" || status === "in_progress",
    ) &&
    !response?.error &&
    !payload.error;
  if (pending && isEmptyPreamble(payload, type)) return { kind: "inspect" };
  // Output and successful terminal events cannot authorize replay, even if
  // they carry an error field. Error envelopes otherwise need no event whitelist.
  if (commitsProtocolEvent(type)) return forward("terminal_event");
  if (
    [payload.status, response?.status].some(
      (status) => status !== undefined && status !== "failed",
    )
  )
    return forward("non_failure_status");
  return code && codes.includes(code)
    ? { kind: "retry", code, diagnostic: diagnostic("error_code_match") }
    : forward(code ? "error_code_not_matched" : "unrecognized_event");
}

/** Apply the same output guards to a complete WebSocket error frame. */
export function retryErrorIsReplayable(
  value: unknown,
  event: string,
  codes: readonly string[],
): boolean {
  return classifyPayload(value, event, codes).kind === "retry";
}

/** Inspect before committing output, then replay the original bytes unchanged. */
export async function inspectRetryError(
  response: Response,
  signal: AbortSignal,
  codes: readonly string[],
  timeoutMs = RETRY_ERROR_INSPECTION_MS,
  options: RetryErrorInspectionOptions = {},
): Promise<RetryErrorInspection> {
  const format = options.format ?? responseFormat(response);
  const maxBytes = options.maxBytes ?? MAX_RETRY_RESPONSE_BYTES;
  if (
    !response.body ||
    !format ||
    (timeoutMs <= 0 && (format === "json" || !options.onEvent))
  )
    return {
      response,
      diagnostic: {
        reason: timeoutMs <= 0 ? "inspection_timeout" : "unsupported_response",
      },
    };

  const state: { decision: RetryDecision } = { decision: { kind: "inspect" } };
  const events: { value: unknown; event: string; replayable: boolean }[] = [];
  const inspect = (value: unknown, event = "") => {
    let replayable = false;
    if (state.decision.kind === "inspect") {
      state.decision = classifyPayload(value, event, codes);
      replayable = state.decision.kind === "retry";
    }
    if (options.onEvent) events.push({ value, event, replayable });
  };
  const stop = (reason: RetryDiagnostic["reason"]): FinalRetryDecision => {
    const final: FinalRetryDecision =
      state.decision.kind === "inspect"
        ? { kind: "forward", diagnostic: { reason } }
        : state.decision;
    state.decision = final;
    return final;
  };
  const observer = new ResponseObserver({
    format,
    onEvent: inspect,
    onIssue: (issue, format) =>
      stop(
        issue === "unsupported_response_format"
          ? "unsupported_response"
          : format === "sse"
            ? "invalid_sse"
            : "invalid_envelope",
      ),
    onDone: () => stop("stream_ended"),
    maxPayloadChars: maxBytes,
  });
  const prefix = await inspectResponsePrefix(response, signal, {
    maxBytes,
    timeoutMs: Math.max(0, Math.min(timeoutMs, RETRY_ERROR_INSPECTION_MS)),
    observe: async (chunk) => {
      if (
        state.decision.kind !== "inspect" &&
        !(observer.format !== "json" && options.onEvent)
      )
        return true;
      if (chunk === undefined) observer.end();
      else observer.push(chunk);
      for (const event of events.splice(0))
        await options.onEvent?.(event.value, event.event, event.replayable);
      if (state.decision.kind !== "inspect" && observer.format === "json")
        observer.discard();
      return state.decision.kind !== "inspect";
    },
  });
  if (observer.format === "json" || !options.onEvent) observer.discard();
  // A timeout/size boundary commits the prefix. Later errors cannot trigger replay.
  const final = stop(
    prefix.stoppedBy === "size"
      ? "inspection_limit"
      : prefix.stoppedBy === "timeout"
        ? "inspection_timeout"
        : "stream_ended",
  );
  return {
    response: prefix.response,
    diagnostic: final.diagnostic,
    ...(final.kind === "retry" ? { errorCode: final.code } : {}),
  };
}
