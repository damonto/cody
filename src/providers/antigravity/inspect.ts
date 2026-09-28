import { inspectResponsePrefix } from "../../gateway/http/response-prefix.ts";
import { SseObserver } from "../../telemetry/stream.ts";
import type { AccountLimit, InspectedResponse } from "../types.ts";
import { antigravityAccountLimit } from "./limits.ts";

const MAX_PREFLIGHT_BYTES = 64 * 1024;
export const MAX_ANTIGRAVITY_PREFLIGHT_MS = 5000;

/** Inspect native errors without rewriting the upstream status, headers or bytes. */
export async function inspectAntigravityResponse(
  response: Response,
  onStreamLimit: (limit: AccountLimit) => Promise<void>,
  signal: AbortSignal,
): Promise<InspectedResponse> {
  const httpLimit = response.status === 429;
  if (
    !response.body ||
    (!httpLimit &&
      (!response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream")))
  )
    return { response };

  const decoder = new TextDecoder();
  let inspecting = true;
  let firstEventSeen = false;
  let accountLimit: AccountLimit | undefined;
  let streamLimit: AccountLimit | undefined;
  let json = "";
  const observer = new SseObserver({
    maxEventChars: MAX_PREFLIGHT_BYTES,
    onIssue: () => {
      firstEventSeen = true;
    },
    onDone: () => {
      firstEventSeen = true;
    },
    onEvent: (value) => {
      const limit = antigravityAccountLimit(value, response.headers);
      if (limit) {
        if (inspecting && !firstEventSeen) accountLimit = limit;
        else if (!streamLimit || limit.resets_at > streamLimit.resets_at)
          streamLimit = limit;
      }
      firstEventSeen = true;
    },
  });
  const forwarded = await inspectResponsePrefix(response, signal, {
    maxBytes: MAX_PREFLIGHT_BYTES,
    timeoutMs: MAX_ANTIGRAVITY_PREFLIGHT_MS,
    async observe(chunk) {
      if (httpLimit) {
        if (!inspecting) return false;
        json += decoder.decode(chunk, { stream: chunk !== undefined });
        if (chunk === undefined) {
          try {
            accountLimit = antigravityAccountLimit(
              JSON.parse(json),
              response.headers,
            );
          } catch {
            /* Keep malformed upstream errors intact. */
          }
        }
        return false;
      }
      observer.push(decoder.decode(chunk, { stream: chunk !== undefined }));
      if (chunk === undefined) observer.end();
      if (streamLimit && !accountLimit) {
        const limit = streamLimit;
        streamLimit = undefined;
        await onStreamLimit(limit);
      }
      return firstEventSeen;
    },
  });
  inspecting = false;
  return { response: forwarded, ...(accountLimit ? { accountLimit } : {}) };
}
