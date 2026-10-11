/** Stop waiting on cancellation; the operation still owns its I/O cleanup. */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    // Always observe the operation, including when the signal was already aborted.
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
}

/** Cancel a delay without leaving its timer or abort listener behind. */
export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
