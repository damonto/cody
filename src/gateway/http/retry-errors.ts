import { SseObserver } from "../../telemetry/stream.ts";
import { z } from "zod";
import { responseFormat } from "./response-format.ts";
import { inspectResponsePrefix } from "./response-prefix.ts";

const MAX_PREFIX_BYTES = 64 * 1024;
const RETRY_ERROR_INSPECTION_MS = 10_000;

const codeSchema = z.string().min(1).max(256).nullish();
const errorSchema = z.object({ code: codeSchema, type: codeSchema }).nullish();
const responseSchema = z.object({
  status: z.string().optional(),
  output: z.array(z.unknown()).nullish(),
  error: errorSchema,
});
const envelopeSchema = responseSchema.extend({
  type: z.string().optional(),
  code: codeSchema,
  response: responseSchema.optional(),
});
type RetryDecision =
  { kind: "inspect" } | { kind: "forward" } | { kind: "retry"; code: string };

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
  if (payload.output?.length || response?.output?.length)
    return { kind: "forward" };
  // An SSE event name and its JSON type must agree when both are present.
  if (event && payload.type && event !== payload.type)
    return { kind: "forward" };
  if (
    (type === "response.created" || type === "response.in_progress") &&
    response?.output?.length === 0 &&
    [payload.status, response.status].every(
      (status) =>
        status === undefined || status === "queued" || status === "in_progress",
    ) &&
    !response.error &&
    !payload.error
  )
    return { kind: "inspect" };
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
