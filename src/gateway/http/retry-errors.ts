import { SseObserver } from "../../telemetry/stream.ts";
import { z } from "zod";
import { responseFormat } from "./response-format.ts";
import { inspectResponsePrefix } from "./response-prefix.ts";

const MAX_PREFIX_BYTES = 64 * 1024;
const RETRY_ERROR_INSPECTION_MS = 10_000;

const codeSchema = z.string().min(1).max(256).nullish();
const errorSchema = z.object({ code: codeSchema, type: codeSchema }).nullish();
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
  error: errorSchema,
});
const envelopeSchema = responseSchema.extend({
  type: z.string().optional(),
  code: codeSchema,
  response: responseSchema.optional(),
  item: z.unknown().optional(),
  part: z.unknown().optional(),
});
type RetryEnvelope = z.infer<typeof envelopeSchema>;
type RetryDecision =
  { kind: "inspect" } | { kind: "forward" } | { kind: "retry"; code: string };

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

/** Unknown or contradictory envelopes never authorize replay. */
function classifyPayload(
  value: unknown,
  event: string,
  codes: readonly string[],
): RetryDecision {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return { kind: "forward" };
  const payload = parsed.data;
  const type = payload.type ?? event;
  const response = payload.response;
  if (hasOutput(payload.output) || hasOutput(response?.output))
    return { kind: "forward" };
  // An SSE event name and its JSON type must agree when both are present.
  if (event && payload.type && event !== payload.type)
    return { kind: "forward" };
  const pending =
    [payload.status, response?.status].every(
      (status) =>
        status === undefined || status === "queued" || status === "in_progress",
    ) &&
    !response?.error &&
    !payload.error;
  if (pending && isEmptyPreamble(payload, type)) return { kind: "inspect" };
  if (type && type !== "error" && type !== "response.failed")
    return { kind: "forward" };
  if (
    [payload.status, response?.status].some(
      (status) => status !== undefined && status !== "failed",
    )
  )
    return { kind: "forward" };
  const error = payload.error ?? response?.error;
  const code =
    error?.code ?? (type === "error" ? payload.code : undefined) ?? error?.type;
  return code && codes.includes(code)
    ? { kind: "retry", code }
    : { kind: "forward" };
}

/** Inspect before committing output, then replay the original bytes unchanged. */
export async function inspectRetryError(
  response: Response,
  signal: AbortSignal,
  codes: readonly string[],
  timeoutMs = RETRY_ERROR_INSPECTION_MS,
): Promise<{ response: Response; errorCode?: string }> {
  const format = responseFormat(response);
  if (!response.body || !format || timeoutMs <= 0) return { response };

  const state: { decision: RetryDecision } = { decision: { kind: "inspect" } };
  const inspect = (value: unknown, event = "") => {
    if (state.decision.kind === "inspect")
      state.decision = classifyPayload(value, event, codes);
  };
  const stop = () => {
    if (state.decision.kind === "inspect") state.decision = { kind: "forward" };
  };
  const decoder = new TextDecoder();
  let json = "";
  const observer =
    format === "sse"
      ? new SseObserver({
          onEvent: inspect,
          onIssue: stop,
          onDone: stop,
          maxEventChars: MAX_PREFIX_BYTES,
        })
      : undefined;
  const replay = await inspectResponsePrefix(response, signal, {
    maxBytes: MAX_PREFIX_BYTES,
    timeoutMs: Math.min(timeoutMs, RETRY_ERROR_INSPECTION_MS),
    observe: async (chunk) => {
      if (state.decision.kind !== "inspect") return true;
      const text =
        chunk === undefined
          ? decoder.decode()
          : decoder.decode(chunk, { stream: true });
      if (observer) {
        observer.push(text);
        if (chunk === undefined) observer.end();
      } else {
        json += text;
        if (chunk === undefined) {
          try {
            inspect(JSON.parse(json) as unknown);
          } catch {
            stop();
          }
        }
      }
      return state.decision.kind !== "inspect";
    },
  });
  // A timeout/size boundary commits the prefix. Later errors cannot trigger replay.
  stop();
  const final = state.decision;
  return {
    response: replay,
    ...(final.kind === "retry" ? { errorCode: final.code } : {}),
  };
}
