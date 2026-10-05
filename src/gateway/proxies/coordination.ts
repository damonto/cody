import { ProxyStrategy } from "../../config/values.ts";
import {
  reconcileBindingOwners,
  type BindingOwners,
  type BindingOwnersSync,
} from "./binding-owners.ts";
import { proxyOwnerKey } from "./configuration.ts";
import { chooseProxy, freshProxyHealth } from "./policy.ts";
import type {
  ProxyGroupSnapshot,
  ProxyOwner,
  ProxySelection,
  StoredProxyHealth,
} from "./schema.ts";

export type ProxyGroupMetadata = {
  revision: number;
  strategy: string;
  signature: string;
};
export interface ProxyNodeState {
  id: string;
  fingerprint: string;
  priority: number;
  disabled: boolean;
  health: StoredProxyHealth;
}

type ProxySyncPlan =
  | { status: "stale_configuration" }
  | {
      status: "current";
      owners: Exclude<BindingOwnersSync, { status: "stale_configuration" }>;
      metadata: ProxyGroupMetadata;
      updateNodes: boolean;
      clearBindings: boolean;
    };

/** Both storage adapters apply the same fences before mutating any state. */
export function planProxyGroupSync(
  group: ProxyGroupSnapshot,
  previous: ProxyGroupMetadata | undefined,
  previousOwners: BindingOwners | undefined,
): ProxySyncPlan {
  const signature = JSON.stringify([
    group.id,
    group.strategy,
    [...group.proxies].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
  if (
    previous &&
    group.revision < previous.revision &&
    signature !== previous.signature
  )
    return { status: "stale_configuration" };
  const owners = reconcileBindingOwners(group, previousOwners);
  if (owners.status === "stale_configuration") return owners;
  return {
    status: "current",
    owners,
    metadata: {
      revision: Math.max(group.revision, previous?.revision ?? 0),
      strategy: group.strategy,
      signature,
    },
    updateNodes: previous?.signature !== signature,
    clearBindings:
      previous !== undefined && previous.strategy !== group.strategy,
  };
}

interface ProxyNodeChanges {
  removed: string[];
  nodes: ProxyNodeState[];
}

export function reconcileProxyNodes(
  group: ProxyGroupSnapshot,
  previous: readonly ProxyNodeState[],
): ProxyNodeChanges {
  const existing = new Map(previous.map((node) => [node.id, node]));
  const incoming = new Set(group.proxies.map((node) => node.id));
  const removed = previous
    .filter((node) => !incoming.has(node.id))
    .map((node) => node.id);
  const nodes = group.proxies.map((node): ProxyNodeState => {
    const old = existing.get(node.id);
    const changed =
      !old ||
      old.fingerprint !== node.fingerprint ||
      old.disabled !== node.disabled;
    return { ...node, health: changed ? freshProxyHealth() : old.health };
  });
  return { removed, nodes };
}

interface ProxySelectionPlan {
  selection: ProxySelection;
  replaceBinding: boolean;
}

/** Select without I/O; temporary exclusions must not replace a healthy sticky binding. */
export function planProxySelection(
  group: ProxyGroupSnapshot,
  owner: ProxyOwner,
  owners: BindingOwners | undefined,
  nodes: readonly ProxyNodeState[],
  bound: string | undefined,
  exclude: readonly string[],
): ProxySelectionPlan {
  const mayBind =
    owners === undefined || owners.keys.includes(proxyOwnerKey(owner));
  if (group.owners !== undefined && !mayBind)
    return { selection: { status: "unavailable" }, replaceBinding: false };
  const healthy = nodes.filter(
    (node) => !node.disabled && node.health.cooling_until === null,
  );
  const existing = healthy.find((node) => node.id === bound);
  const selected =
    existing && !exclude.includes(existing.id)
      ? existing
      : chooseProxy(
          healthy.filter((node) => !exclude.includes(node.id)),
          group.strategy,
        );
  return {
    selection: selected
      ? {
          status: "selected",
          lease: {
            proxy_id: selected.id,
            generation: selected.health.generation,
          },
        }
      : { status: "unavailable" },
    replaceBinding:
      group.strategy === ProxyStrategy.Sticky && !existing && mayBind,
  };
}
