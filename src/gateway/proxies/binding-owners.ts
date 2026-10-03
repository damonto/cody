import { z } from "zod";
import { proxyOwnerKey } from "./configuration.ts";
import type { ProxyGroupSnapshot } from "./schema.ts";

export const bindingOwnersSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  keys: z.array(z.string()),
});
export type BindingOwners = z.output<typeof bindingOwnersSchema>;

export type BindingOwnersSync =
  | { status: "stale_configuration" }
  | {
      status: "current";
      owners: BindingOwners | undefined;
      write: false;
      prune: false;
    }
  | {
      status: "current";
      owners: BindingOwners;
      write: true;
      prune: boolean;
    };

/** Partial OAuth snapshots cannot replace the committed ownership list. */
export function reconcileBindingOwners(
  group: ProxyGroupSnapshot,
  previous: BindingOwners | undefined,
): BindingOwnersSync {
  if (group.owners === undefined) {
    return { status: "current", owners: previous, write: false, prune: false };
  }
  const keys = [...new Set(group.owners.map(proxyOwnerKey))].sort();
  const unchanged =
    previous !== undefined &&
    keys.length === previous.keys.length &&
    keys.every((key, index) => key === previous.keys[index]);
  if (previous && group.revision < previous.revision && !unchanged) {
    return { status: "stale_configuration" };
  }
  if (unchanged && group.revision <= previous.revision) {
    return { status: "current", owners: previous, write: false, prune: false };
  }
  return {
    status: "current",
    owners: { revision: group.revision, keys },
    write: true,
    prune: !unchanged,
  };
}
