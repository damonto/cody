import { useRef } from "react";

/** Keep the original request across retries, including a lost response after commit. */
export function useRetryableRequest<T>() {
  const pending = useRef<{ input: string; request: T } | null>(null);
  return (value: unknown, create: () => T): T => {
    const input = JSON.stringify(value);
    if (pending.current?.input !== input)
      pending.current = { input, request: create() };
    return pending.current.request;
  };
}
