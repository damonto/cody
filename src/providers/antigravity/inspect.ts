import { SseObserver } from "../../telemetry/stream.ts";
import type { AccountLimit, InspectedResponse } from "../types.ts";
import { antigravityAccountLimit } from "./limits.ts";

const MAX_PREFLIGHT_BYTES = 64 * 1024;
export const MAX_ANTIGRAVITY_PREFLIGHT_MS = 5000;

/** Bounded preflight; successful streams retain their original bytes and backpressure. */
export async function inspectAntigravityResponse(
  response: Response,
  onStreamLimit: (limit: AccountLimit) => Promise<void>,
  signal: AbortSignal,
): Promise<InspectedResponse> {
  if (!response.body) return { response };
  const httpLimit = response.status === 429;
  if (
    !httpLimit &&
    (!response.ok ||
      !response.headers.get("content-type")?.includes("text/event-stream"))
  )
    return { response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let firstEventSeen = false;
  let preflight = true;
  let firstLimit: AccountLimit | undefined;
  let firstError: unknown;
  let pendingLimit: AccountLimit | undefined;
  let done = false;
  let released = false;
  let json = "";
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
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
        if (preflight && !firstEventSeen) {
          firstLimit = limit;
          firstError = value;
        } else pendingLimit = limit;
      }
      firstEventSeen = true;
    },
  });
  const observe = (value: Uint8Array | undefined) => {
    if (httpLimit) {
      if (bufferedBytes <= MAX_PREFLIGHT_BYTES && preflight)
        json += decoder.decode(value, { stream: value !== undefined });
      return;
    }
    observer.push(decoder.decode(value, { stream: value !== undefined }));
    if (value === undefined) observer.end();
  };
  let expire: () => void = () => {};
  const timeout = new Promise<undefined>((resolve) => {
    expire = () => resolve(undefined);
  });
  const timer = setTimeout(expire, MAX_ANTIGRAVITY_PREFLIGHT_MS);
  try {
    signal.throwIfAborted();
    while (!firstEventSeen && bufferedBytes < MAX_PREFLIGHT_BYTES && !done) {
      pendingRead ??= reader.read();
      const next = await Promise.race([pendingRead, timeout]);
      signal.throwIfAborted();
      if (!next) break;
      pendingRead = undefined;
      done = next.done;
      if (next.value) {
        buffered.push(next.value);
        bufferedBytes += next.value.byteLength;
      }
      observe(next.value);
    }
    preflight = false;
    if (httpLimit && done && bufferedBytes <= MAX_PREFLIGHT_BYTES) {
      try {
        firstLimit = antigravityAccountLimit(
          JSON.parse(json),
          response.headers,
        );
      } catch {
        /* Preserve unrecognised upstream errors. */
      }
    }
    if (firstLimit && !httpLimit) {
      await reader.cancel();
      release();
      const headers = new Headers(response.headers);
      for (const name of [
        "content-length",
        "content-encoding",
        "content-md5",
        "digest",
        "content-digest",
      ])
        headers.delete(name);
      headers.set("content-type", "application/json");
      return {
        response: new Response(JSON.stringify(firstError), {
          status: response.status,
          headers,
        }),
        accountLimit: firstLimit,
      };
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    release();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let bufferIndex = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (pendingLimit) {
            const limit = pendingLimit;
            pendingLimit = undefined;
            await onStreamLimit(limit);
          }
          if (bufferIndex < buffered.length) {
            controller.enqueue(buffered[bufferIndex++]!);
            return;
          }
          if (done) {
            controller.close();
            release();
            return;
          }
          const next = await (pendingRead ?? reader.read());
          pendingRead = undefined;
          signal.throwIfAborted();
          done = next.done;
          observe(next.value);
          if (pendingLimit) {
            const limit = pendingLimit;
            pendingLimit = undefined;
            await onStreamLimit(limit);
          }
          if (next.done) {
            controller.close();
            release();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await reader.cancel(error).catch(() => {});
          release();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        release();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    ...(firstLimit ? { accountLimit: firstLimit } : {}),
  };
}
