/**
 * Proxy-group coordination over object storage. Mirrors the SQL-backed
 * Cloudflare Durable Object: node health, sticky bindings and the configuration
 * signature live under one object lock per group.
 */
import { identifierSchema } from "../../config/schema.ts";
import {
  chooseProxy,
  currentProxyHealth,
  freshProxyHealth,
  observeProxyHealth,
} from "../../gateway/proxies/policy.ts";
import {
  proxyGroupSnapshotSchema,
  proxyGroupStatusSchema,
  proxyOutcomeSchema,
  proxySelectInputSchema,
  storedProxyHealthSchema,
  type ProxyGroupSnapshot,
  type ProxyGroupStatus,
  type ProxySelection,
  type StoredProxyHealth,
} from "../../gateway/proxies/schema.ts";
import type { ProxyGroupObject } from "../bindings.ts";
import type { ObjectContext, ObjectTransaction } from "../object-context.ts";

const META_KEY = "meta";
const NODE_PREFIX = "node:";
const BINDING_PREFIX = "binding:";

interface Metadata {
  revision: number;
  strategy: string;
  signature: string;
}

interface StoredNode {
  id: string;
  fingerprint: string;
  priority: number;
  disabled: boolean;
  health: StoredProxyHealth;
}

interface StoredBinding {
  provider_id: string;
  credential_id: string | null;
  proxy_id: string;
  created_at: number;
}

export class ProxyGroupCore implements ProxyGroupObject {
  constructor(private readonly ctx: ObjectContext) {}

  private async nodes(transaction: ObjectTransaction): Promise<StoredNode[]> {
    return [
      ...(await transaction.list<StoredNode>({ prefix: NODE_PREFIX })).values(),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async bindings(
    transaction: ObjectTransaction,
  ): Promise<Map<string, StoredBinding>> {
    return transaction.list<StoredBinding>({ prefix: BINDING_PREFIX });
  }

  private async deleteBindingsTo(
    transaction: ObjectTransaction,
    proxyId: string,
  ): Promise<void> {
    for (const [key, binding] of await this.bindings(transaction)) {
      if (binding.proxy_id === proxyId) await transaction.delete(key);
    }
  }

  private async saveNode(
    transaction: ObjectTransaction,
    node: StoredNode,
  ): Promise<void> {
    await transaction.put(`${NODE_PREFIX}${node.id}`, node);
  }

  private async refreshedHealth(
    transaction: ObjectTransaction,
    node: StoredNode,
    now: number,
  ): Promise<StoredProxyHealth> {
    const health = currentProxyHealth(
      storedProxyHealthSchema.parse(node.health),
      now,
    );
    if (JSON.stringify(health) !== JSON.stringify(node.health)) {
      await this.saveNode(transaction, { ...node, health });
    }
    return health;
  }

  private async sync(
    transaction: ObjectTransaction,
    group: ProxyGroupSnapshot,
  ): Promise<boolean> {
    const signature = JSON.stringify([
      group.id,
      group.strategy,
      [...group.proxies].sort((a, b) => a.id.localeCompare(b.id)),
    ]);
    const previous = await transaction.get<Metadata>(META_KEY);
    if (
      previous &&
      group.revision < previous.revision &&
      signature !== previous.signature
    ) {
      return false;
    }
    if (previous?.signature === signature) {
      if (group.revision > previous.revision) {
        await transaction.put(META_KEY, {
          ...previous,
          revision: group.revision,
        });
      }
      return true;
    }
    const existing = new Map(
      (await this.nodes(transaction)).map((node) => [node.id, node]),
    );
    const incoming = new Set(group.proxies.map((node) => node.id));
    for (const id of existing.keys()) {
      if (incoming.has(id)) continue;
      await transaction.delete(`${NODE_PREFIX}${id}`);
      await this.deleteBindingsTo(transaction, id);
    }
    if (previous && previous.strategy !== group.strategy) {
      for (const key of (await this.bindings(transaction)).keys()) {
        await transaction.delete(key);
      }
    }
    for (const node of group.proxies) {
      const old = existing.get(node.id);
      const changed =
        !old ||
        old.fingerprint !== node.fingerprint ||
        old.disabled !== node.disabled;
      await this.saveNode(transaction, {
        id: node.id,
        fingerprint: node.fingerprint,
        priority: node.priority,
        disabled: node.disabled,
        health: changed || !old ? freshProxyHealth() : old.health,
      });
      if (node.disabled) await this.deleteBindingsTo(transaction, node.id);
    }
    await transaction.put(META_KEY, {
      revision: Math.max(group.revision, previous?.revision ?? 0),
      strategy: group.strategy,
      signature,
    } satisfies Metadata);
    return true;
  }

  select(value: unknown): Promise<ProxySelection> {
    const { group, owner, exclude } = proxySelectInputSchema.parse(value);
    return this.ctx.storage.transaction(async (transaction) => {
      if (!(await this.sync(transaction, group))) {
        return { status: "stale_configuration" };
      }
      const now = Date.now();
      const nodes: (StoredNode & { state: StoredProxyHealth })[] = [];
      for (const node of await this.nodes(transaction)) {
        nodes.push({
          ...node,
          state: await this.refreshedHealth(transaction, node, now),
        });
      }
      const healthy = nodes.filter(
        (node) => !node.disabled && node.state.cooling_until === null,
      );
      const key = `${BINDING_PREFIX}${JSON.stringify([
        owner.provider_id,
        owner.credential_id ?? null,
      ])}`;
      const bound =
        group.strategy === "sticky"
          ? (await transaction.get<StoredBinding>(key))?.proxy_id
          : undefined;
      const existing = healthy.find((node) => node.id === bound);
      const selected =
        existing && !exclude.includes(existing.id)
          ? existing
          : chooseProxy(
              healthy.filter((node) => !exclude.includes(node.id)),
              group.strategy,
            );
      if (group.strategy === "sticky" && !existing) {
        await transaction.delete(key);
        if (selected) {
          await transaction.put(key, {
            provider_id: owner.provider_id,
            credential_id: owner.credential_id ?? null,
            proxy_id: selected.id,
            created_at: now,
          } satisfies StoredBinding);
        }
      }
      return selected
        ? {
            status: "selected",
            lease: {
              proxy_id: selected.id,
              generation: selected.state.generation,
            },
          }
        : { status: "unavailable" };
    });
  }

  observe(value: unknown): Promise<void> {
    const event = proxyOutcomeSchema.parse(value);
    return this.ctx.storage.transaction(async (transaction) => {
      const node = await transaction.get<StoredNode>(
        `${NODE_PREFIX}${event.lease.proxy_id}`,
      );
      if (!node || node.disabled) return;
      const previous = storedProxyHealthSchema.parse(node.health);
      const next = observeProxyHealth(previous, event, Date.now());
      if (JSON.stringify(next) === JSON.stringify(node.health)) return;
      await this.saveNode(transaction, { ...node, health: next });
      if (next.cooling_until !== null) {
        await this.deleteBindingsTo(transaction, node.id);
      }
    });
  }

  getStatus(value: unknown): Promise<ProxyGroupStatus> {
    const group = proxyGroupSnapshotSchema.parse(value);
    return this.ctx.storage.transaction(async (transaction) => {
      if (!(await this.sync(transaction, group))) {
        throw new Error("Proxy configuration is stale");
      }
      const now = Date.now();
      const proxies = [];
      for (const node of await this.nodes(transaction)) {
        const health = await this.refreshedHealth(transaction, node, now);
        proxies.push({
          id: node.id,
          status: node.disabled
            ? "disabled"
            : health.cooling_until !== null
              ? "cooling"
              : "healthy",
          failures: health.failures.length,
          cooling_until: health.cooling_until,
        });
      }
      const bindings = [...(await this.bindings(transaction)).entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, binding]) => ({
          provider_id: binding.provider_id,
          ...(binding.credential_id === null
            ? {}
            : { credential_id: binding.credential_id }),
          proxy_id: binding.proxy_id,
          created_at: binding.created_at,
        }));
      return proxyGroupStatusSchema.parse({
        group_id: group.id,
        proxies,
        bindings,
      });
    });
  }

  clear(value: unknown, proxyId: string): Promise<boolean> {
    const group = proxyGroupSnapshotSchema.parse(value);
    const id = identifierSchema.parse(proxyId);
    return this.ctx.storage.transaction(async (transaction) => {
      if (!(await this.sync(transaction, group))) {
        throw new Error("Proxy configuration is stale");
      }
      if (!group.proxies.some((node) => node.id === id)) return false;
      const node = await transaction.get<StoredNode>(`${NODE_PREFIX}${id}`);
      if (node) {
        await this.saveNode(transaction, {
          ...node,
          health: freshProxyHealth(),
        });
      }
      return true;
    });
  }
}
