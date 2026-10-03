import { useState } from "react";

export interface ResourceSnapshot<T> {
  version: number;
  item: T;
  etag?: string;
}
/** Keep the original value/version together. Tags also detect changes to masked secrets. */
export function useResourceEditor<T>(current: ResourceSnapshot<T>) {
  const [base, setBase] = useState(current);
  const sameValue = JSON.stringify(base.item) === JSON.stringify(current.item);
  // A successful save supplies its value/version. Adopt its tag only from a read of that exact commit.
  if (
    current.etag &&
    !base.etag &&
    current.version === base.version &&
    sameValue
  ) {
    setBase({ ...base, etag: current.etag });
  }
  const unchanged = current.etag
    ? base.etag === current.etag ||
      (!base.etag && current.version === base.version && sameValue)
    : sameValue;
  const version = unchanged
    ? Math.max(base.version, current.version)
    : base.version;
  const conflict = current.version > base.version && !unchanged;
  return { initial: base.item, version, conflict, accept: setBase };
}
