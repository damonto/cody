import type { ApiProtocol } from "../gateway/protocol.ts";
import type { NormalizedUsage } from "../billing/types.ts";
import { record, UsageAccumulator } from "./usage.ts";

/** Inspect only a discarded retry response, with bounded size and wait time. */
export async function retryResponseUsage(
  response: Response,
  protocol: ApiProtocol,
  extract?: (payload: unknown) => unknown,
): Promise<NormalizedUsage | null> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.toLowerCase().includes("json")
  )
    return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let interrupted = false;
  const timeout = setTimeout(() => {
    interrupted = true;
    void reader.cancel().catch(() => {});
  }, 250);
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      text += decoder.decode(item.value, { stream: true });
      if (text.length > 64 * 1024) {
        interrupted = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
    if (interrupted) return null;
    const payload = record(JSON.parse(text + decoder.decode()) as unknown);
    const usage = new UsageAccumulator(protocol);
    if (extract) usage.add(extract(payload));
    else {
      usage.add(payload?.usage);
      usage.add(record(payload?.response)?.usage);
    }
    const result = usage.snapshot();
    return result.status === "missing" ? null : result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
