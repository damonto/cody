import { object } from "./json.ts";
import { xaiBadCredentials } from "./errors.ts";
import { inspectResponsePrefix } from "../../gateway/http/response-prefix.ts";
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
  const observer = new SseObserver({
    maxEventChars: 65536,
    onIssue: () => {
      ready = true;
    },
    onDone: () => {
      ready = true;
    },
    onEvent(value) {
      const limit = xaiLimit(value, response.headers, model);
      if (limit) {
        if (inspecting && !ready) found = limit;
        else late = limit;
        ready = true;
      } else if (
        ![
          "response.created",
          "response.in_progress",
          "response.output_item.added",
          "response.content_part.added",
          "response.reasoning_summary_part.added",
        ].includes(String(object(value).type))
      )
        ready = true;
    },
  });
  const { response: forwarded } = await inspectResponsePrefix(
    response,
    signal,
    {
      maxBytes: 65536,
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
          found = xaiLimit(value, response.headers, model);
          return true;
        }
        observer.push(decoder.decode(chunk, { stream: chunk !== undefined }));
        if (chunk === undefined) observer.end();
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
