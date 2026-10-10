import { UsageStatus } from "../billing/values.ts";
import { type ApiProtocol } from "../gateway/protocol-values.ts";

import type { NormalizedUsage } from "../billing/types.ts";
import { record, UsageAccumulator } from "./usage.ts";
import { ResponseObserver } from "./response-observer.ts";
import { responseFormat } from "../gateway/http/response-format.ts";
import { MAX_RETRY_RESPONSE_BYTES } from "../shared/response-limits.ts";

/** Inspect only a discarded retry response, with bounded size and wait time. */
export async function retryResponseUsage(
  response: Response,
  protocol: ApiProtocol,
  options: {
    extract?: (payload: unknown) => unknown;
    detectFormat?: boolean | undefined;
  } = {},
): Promise<NormalizedUsage | null> {
  const format =
    responseFormat(response) ?? (options.detectFormat ? "auto" : undefined);
  if (!response.body || !format) return null;
  const reader = response.body.getReader();
  const usage = new UsageAccumulator(protocol);
  let bytes = 0;
  let interrupted = false;
  let complete = false;
  const observe = (value: unknown, event = "") => {
    const payload = record(value);
    if (options.extract) usage.add(options.extract(payload));
    else {
      usage.add(payload?.usage);
      usage.add(record(payload?.response)?.usage);
      usage.add(record(payload?.message)?.usage);
    }
    const type = typeof payload?.type === "string" ? payload.type : event;
    if (
      [
        "error",
        "response.failed",
        "response.completed",
        "response.incomplete",
        "message_stop",
      ].includes(type)
    )
      complete = true;
  };
  const observer = new ResponseObserver({
    format,
    onEvent: observe,
    onIssue: () => {
      interrupted = true;
    },
    onDone: () => {
      complete = true;
    },
    maxPayloadChars: MAX_RETRY_RESPONSE_BYTES,
  });
  const timeout = setTimeout(() => {
    interrupted = true;
    void reader.cancel().catch(() => {});
  }, 250);
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RETRY_RESPONSE_BYTES) {
        interrupted = true;
        void reader.cancel().catch(() => {});
        break;
      }
      observer.push(item.value);
      if (complete || interrupted) break;
    }
    if (interrupted) return null;
    observer.end();
    if (interrupted) return null;
    const result = usage.snapshot();
    return result.status === UsageStatus.Missing ? null : result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
