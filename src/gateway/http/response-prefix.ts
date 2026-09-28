interface PrefixInspection {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Observe bytes once. Return true when enough of the prefix has been seen. */
  readonly observe: (chunk: Uint8Array | undefined) => Promise<boolean>;
}

/** Read a bounded prefix, then replay it and forward the remainder on demand. */
export async function inspectResponsePrefix(
  response: Response,
  signal: AbortSignal,
  inspection: PrefixInspection,
): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let remainder: Uint8Array | undefined;
  let done = false;
  let released = false;
  let cancellation: Promise<void> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= reader
      .cancel(reason)
      .catch(() => {})
      .finally(release);
    return cancellation;
  };
  const abort = () => {
    void cancel(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });

  let expire = () => {};
  const timeout = new Promise<undefined>((resolve) => {
    expire = () => resolve(undefined);
  });
  const timer = setTimeout(expire, inspection.timeoutMs);
  try {
    signal.throwIfAborted();
    let bytes = 0;
    while (bytes < inspection.maxBytes) {
      pending ??= reader.read();
      const next = await Promise.race([pending, timeout]);
      signal.throwIfAborted();
      if (!next) break;
      pending = undefined;
      done = next.done;
      if (next.done) {
        await inspection.observe(undefined);
        signal.throwIfAborted();
        release();
        break;
      }
      const observed = next.value.subarray(0, inspection.maxBytes - bytes);
      if (observed.byteLength < next.value.byteLength)
        remainder = next.value.subarray(observed.byteLength);
      prefix.push(observed);
      bytes += observed.byteLength;
      const sufficient = await inspection.observe(observed);
      signal.throwIfAborted();
      if (sufficient) break;
    }
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (cancellation) return;
          const buffered = prefix[index];
          if (buffered !== undefined) {
            index++;
            controller.enqueue(buffered);
            if (index === prefix.length) prefix.length = 0;
            return;
          }
          if (done) {
            controller.close();
            return;
          }
          const next = remainder
            ? { done: false as const, value: remainder }
            : await (pending ?? reader.read());
          pending = undefined;
          remainder = undefined;
          signal.throwIfAborted();
          if (cancellation) return;
          done = next.done;
          await inspection.observe(next.value);
          signal.throwIfAborted();
          if (cancellation) return;
          if (next.done) {
            controller.close();
            release();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await cancel(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
