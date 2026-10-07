interface PrefixInspection {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Observe bytes once. Return true when enough of the prefix has been seen. */
  readonly observe: (chunk: Uint8Array | undefined) => Promise<boolean>;
}

interface InspectedPrefix {
  readonly response: Response;
  readonly stoppedBy: "observer" | "eof" | "size" | "timeout";
}

/** Read a bounded prefix, then replay it and forward the remainder on demand. */
export async function inspectResponsePrefix(
  response: Response,
  signal: AbortSignal,
  inspection: PrefixInspection,
): Promise<InspectedPrefix> {
  if (!Number.isSafeInteger(inspection.maxBytes) || inspection.maxBytes <= 0)
    throw new RangeError("maxBytes must be a positive safe integer");
  if (!Number.isFinite(inspection.timeoutMs) || inspection.timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive finite number");
  if (!response.body) return { response, stoppedBy: "eof" };
  const reader = response.body.getReader();
  // Coalesce small transport chunks so the byte budget also bounds bookkeeping.
  // Grow on demand, as most responses need far less than the maximum capacity.
  let prefix = new Uint8Array(0);
  let prefixBytes = 0;
  let stoppedBy: InspectedPrefix["stoppedBy"] = "size";
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
    prefix = new Uint8Array(0);
    prefixBytes = 0;
    remainder = undefined;
    pending = undefined;
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
    while (prefixBytes < inspection.maxBytes) {
      pending ??= reader.read();
      const next = await Promise.race([pending, timeout]);
      signal.throwIfAborted();
      if (!next) {
        stoppedBy = "timeout";
        break;
      }
      pending = undefined;
      done = next.done;
      if (next.done) {
        stoppedBy = "eof";
        await inspection.observe(undefined);
        signal.throwIfAborted();
        release();
        break;
      }
      const observed = next.value.subarray(
        0,
        inspection.maxBytes - prefixBytes,
      );
      if (observed.byteLength < next.value.byteLength)
        remainder = next.value.subarray(observed.byteLength);
      const requiredBytes = prefixBytes + observed.byteLength;
      if (requiredBytes > prefix.byteLength) {
        const capacity = Math.min(
          inspection.maxBytes,
          Math.max(64 * 1024, requiredBytes, prefix.byteLength * 2),
        );
        const grown = new Uint8Array(capacity);
        grown.set(prefix.subarray(0, prefixBytes));
        prefix = grown;
      }
      prefix.set(observed, prefixBytes);
      prefixBytes = requiredBytes;
      const sufficient = await inspection.observe(observed);
      signal.throwIfAborted();
      if (sufficient) {
        stoppedBy = "observer";
        break;
      }
    }
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (cancellation) return;
          if (prefixBytes > 0) {
            const buffered = prefix.subarray(0, prefixBytes);
            prefix = new Uint8Array(0);
            prefixBytes = 0;
            controller.enqueue(buffered);
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
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    stoppedBy,
  };
}
