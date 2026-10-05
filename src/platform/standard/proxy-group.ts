import {
  planProxyGroupSync,
  reconcileProxyNodes,
  planProxySelection,
  type ProxyGroupMetadata,
  type ProxyNodeState,
} from "../../gateway/proxies/coordination.ts";
import { ProxyStrategy } from "../../config/values.ts";

/**
 * Proxy-group coordination over object storage. Mirrors the SQL-backed
 * Cloudflare Durable Object: node health, sticky bindings and the configuration
 * signature live under one object lock per group.
 */
import { identifierSchema } from "../../config/schema.ts";
import { proxyOwnerKey } from "../../gateway/proxies/configuration.ts";
import {
  type BindingOwners,
  type BindingOwnersSync,
} from "../../gateway/proxies/binding-owners.ts";
import {
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
const OWNERS_KEY = "binding-owners";

interface StoredBinding {
  provider_id: string;
  credential_id: string | null;
  proxy_id: string;
  created_at: number;
}

export class ProxyGroupCore implements ProxyGroupObject {
  constructor(private readonly ctx: ObjectContext) {}

  private async nodes(
    transaction: ObjectTransaction,
  ): Promise<ProxyNodeState[]> {
    return [
      ...(
        await transaction.list<ProxyNodeState>({ prefix: NODE_PREFIX })
      ).values(),
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
    node: ProxyNodeState,
  ): Promise<void> {
    await transaction.put(`${NODE_PREFIX}${node.id}`, node);
  }

  private async refreshedHealth(
    transaction: ObjectTransaction,
    node: ProxyNodeState,
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
  ): Promise<BindingOwnersSync> {
    const previous = await transaction.get<ProxyGroupMetadata>(META_KEY);
    const oldOwners = await transaction.get<BindingOwners>(OWNERS_KEY);
    const plan = planProxyGroupSync(group, previous, oldOwners);
    if (plan.status === "stale_configuration") return plan;
    const result = plan.owners;
    if (result.prune) {
      const allowed = new Set(
        result.owners.keys.map((key) => `${BINDING_PREFIX}${key}`),
      );
      for (const key of (await this.bindings(transaction)).keys()) {
        if (!allowed.has(key)) await transaction.delete(key);
      }
    }
    if (result.write) await transaction.put(OWNERS_KEY, result.owners);
    if (plan.updateNodes) {
      const changes = reconcileProxyNodes(group, await this.nodes(transaction));
      for (const id of changes.removed) {
        await transaction.delete(`${NODE_PREFIX}${id}`);
        await this.deleteBindingsTo(transaction, id);
      }
      if (plan.clearBindings) {
        for (const key of (await this.bindings(transaction)).keys())
          await transaction.delete(key);
      }
      for (const node of changes.nodes) {
        await this.saveNode(transaction, node);
        if (node.disabled) await this.deleteBindingsTo(transaction, node.id);
      }
    }
    if (plan.updateNodes || plan.metadata.revision !== previous?.revision)
      await transaction.put(META_KEY, plan.metadata);
    return result;
  }

  select(value: unknown): Promise<ProxySelection> {
    const { group, owner, exclude } = proxySelectInputSchema.parse(value);
    return this.ctx.storage.transaction(async (transaction) => {
      const synced = await this.sync(transaction, group);
      if (synced.status === "stale_configuration") return synced;
      const now = Date.now();
      const nodes: ProxyNodeState[] = [];
      for (const node of await this.nodes(transaction)) {
        nodes.push({
          ...node,
          health: await this.refreshedHealth(transaction, node, now),
        });
      }
      const key = `${BINDING_PREFIX}${proxyOwnerKey(owner)}`;
      const bound =
        group.strategy === ProxyStrategy.Sticky
          ? (await transaction.get<StoredBinding>(key))?.proxy_id
          : undefined;
      const plan = planProxySelection(
        group,
        owner,
        synced.owners,
        nodes,
        bound,
        exclude,
      );
      if (plan.replaceBinding) {
        await transaction.delete(key);
        if (plan.selection.status === "selected")
          await transaction.put(key, {
            provider_id: owner.provider_id,
            credential_id: owner.credential_id ?? null,
            proxy_id: plan.selection.lease.proxy_id,
            created_at: now,
          } satisfies StoredBinding);
      }
      return plan.selection;
    });
  }

  observe(value: unknown): Promise<void> {
    const event = proxyOutcomeSchema.parse(value);
    return this.ctx.storage.transaction(async (transaction) => {
      const node = await transaction.get<ProxyNodeState>(
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
      if (
        (await this.sync(transaction, group)).status === "stale_configuration"
      ) {
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
      if (
        (await this.sync(transaction, group)).status === "stale_configuration"
      ) {
        throw new Error("Proxy configuration is stale");
      }
      if (!group.proxies.some((node) => node.id === id)) return false;
      const node = await transaction.get<ProxyNodeState>(`${NODE_PREFIX}${id}`);
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
