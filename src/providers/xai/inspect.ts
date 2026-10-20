import { MAX_QUOTA_ERROR_BYTES } from "../../shared/payload-limits.ts";
import { xaiBadCredentials } from "./errors.ts";
import { inspectResponsePrefix } from "../../gateway/http/response-prefix.ts";
import { responseReplaySafety } from "../../gateway/http/retry-errors.ts";
import { SseObserver } from "../../telemetry/stream.ts";
import type { InspectedResponse } from "../types.ts";
import { xaiLimit, type XaiLimit } from "./limits.ts";

export async function inspectXaiResponse(
  response: Response,
  model: string,
  onLateLimit: (limit: XaiLimit) => Promise<void>,
  signal: AbortSignal,
  onCredentialRejected?: () => Promise<void>,
): Promise<InspectedResponse> {
  if (
    !response.body ||
    (!response.ok && ![402, 403, 429].includes(response.status))
  )
    return { response };
  const sse = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  if (response.ok && !sse) return { response };
  const decoder = new TextDecoder();
  let inspecting = true;
  let ready = false;
  let found: XaiLimit | undefined;
  let late: XaiLimit | undefined;
  let json = "";
  const inspectEvent = (value: unknown, event: string) => {
    const limit = xaiLimit(value, response.headers, model);
    const replay = responseReplaySafety(value, event);
    if (limit) {
      if (inspecting && !ready && replay === "eligible") found = limit;
      else late = limit;
      ready = true;
    } else if (replay !== "inspect") ready = true;
  };
  const observer = new SseObserver({
    maxEventBytes: MAX_QUOTA_ERROR_BYTES,
    onIssue: () => {
      ready = true;
    },
    onDone: () => {
      ready = true;
    },
    onEvent: inspectEvent,
  });
  const { response: forwarded } = await inspectResponsePrefix(
    response,
    signal,
    {
      maxBytes: MAX_QUOTA_ERROR_BYTES,
      timeoutMs: 5000,
      async observe(chunk) {
        if (!sse) {
          if (!inspecting) return true;
          json += decoder.decode(chunk, { stream: chunk !== undefined });
          let value: unknown;
          try {
            value = JSON.parse(json);
          } catch {
            return chunk === undefined;
          }
          if (response.status === 403 && xaiBadCredentials(value))
            await onCredentialRejected?.();
          inspectEvent(value, "");
          ready = true;
        } else {
          observer.push(decoder.decode(chunk, { stream: chunk !== undefined }));
          if (chunk === undefined) observer.end();
        }
        if (late) {
          const limit = late;
          late = undefined;
          await onLateLimit(limit);
        }
        return ready;
      },
    },
  );
  inspecting = false;
  return { response: forwarded, ...(found ? { accountLimit: found } : {}) };
}
