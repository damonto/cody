import {
  planProxyGroupSync,
  reconcileProxyNodes,
  planProxySelection,
  type ProxyGroupMetadata,
} from "./coordination.ts";
import { ProxyStrategy } from "../../config/values.ts";

import { DurableObject } from "cloudflare:workers";
import { identifierSchema } from "../../config/schema.ts";
import { proxyOwnerKey } from "./configuration.ts";
import {
  bindingOwnersSchema,
  type BindingOwners,
  type BindingOwnersSync,
} from "./binding-owners.ts";
import {
  currentProxyHealth,
  freshProxyHealth,
  observeProxyHealth,
} from "./policy.ts";
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
} from "./schema.ts";

interface NodeRow extends Record<string, SqlStorageValue> {
  id: string;
  fingerprint: string;
  priority: number;
  disabled: number;
  health: string;
}

/** One coordination object per group; it never sends traffic or stores proxy credentials. */
export class ProxyGroup extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proxy_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, strategy TEXT NOT NULL, signature TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proxy_nodes (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, priority INTEGER NOT NULL, disabled INTEGER NOT NULL, health TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proxy_bindings (
      owner TEXT PRIMARY KEY, provider_id TEXT NOT NULL, credential_id TEXT, proxy_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proxy_bindings_node ON proxy_bindings(proxy_id);
    CREATE TABLE IF NOT EXISTS proxy_binding_owners (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, keys TEXT NOT NULL
    );`);
  }

  private bindingOwners(): BindingOwners | undefined {
    const row = this.ctx.storage.sql
      .exec<{ revision: number; keys: string }>(
        "SELECT revision, keys FROM proxy_binding_owners WHERE id = 1",
      )
      .toArray()[0];
    return row
      ? bindingOwnersSchema.parse({
          revision: row.revision,
          keys: JSON.parse(row.keys),
        })
      : undefined;
  }

  private rows(): NodeRow[] {
    return this.ctx.storage.sql
      .exec<NodeRow>("SELECT * FROM proxy_nodes ORDER BY id")
      .toArray();
  }

  private saveHealth(id: string, health: StoredProxyHealth): void {
    this.ctx.storage.sql.exec(
      "UPDATE proxy_nodes SET health = ? WHERE id = ?",
      JSON.stringify(health),
      id,
    );
  }

  private health(row: NodeRow, now: number): StoredProxyHealth {
    const health = currentProxyHealth(
      storedProxyHealthSchema.parse(JSON.parse(row.health)),
      now,
    );
    if (JSON.stringify(health) !== row.health) {
      this.saveHealth(row.id, health);
    }
    return health;
  }

  private sync(group: ProxyGroupSnapshot): BindingOwnersSync {
    const sql = this.ctx.storage.sql;
    const previous = sql
      .exec<ProxyGroupMetadata>(
        "SELECT revision, strategy, signature FROM proxy_metadata WHERE id = 1",
      )
      .toArray()[0];
    const plan = planProxyGroupSync(group, previous, this.bindingOwners());
    if (plan.status === "stale_configuration") return plan;
    const result = plan.owners;
    if (result.prune)
      sql.exec(
        "DELETE FROM proxy_bindings WHERE owner NOT IN (SELECT value FROM json_each(?))",
        JSON.stringify(result.owners.keys),
      );
    if (result.write)
      sql.exec(
        "INSERT INTO proxy_binding_owners (id, revision, keys) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, keys = excluded.keys",
        result.owners.revision,
        JSON.stringify(result.owners.keys),
      );
    if (plan.updateNodes) {
      const changes = reconcileProxyNodes(
        group,
        this.rows().map((row) => ({
          ...row,
          disabled: !!row.disabled,
          health: storedProxyHealthSchema.parse(JSON.parse(row.health)),
        })),
      );
      for (const id of changes.removed) {
        sql.exec("DELETE FROM proxy_nodes WHERE id = ?", id);
        sql.exec("DELETE FROM proxy_bindings WHERE proxy_id = ?", id);
      }
      if (plan.clearBindings) sql.exec("DELETE FROM proxy_bindings");
      for (const node of changes.nodes) {
        sql.exec(
          "INSERT INTO proxy_nodes (id, fingerprint, priority, disabled, health) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint, priority = excluded.priority, disabled = excluded.disabled, health = excluded.health",
          node.id,
          node.fingerprint,
          node.priority,
          Number(node.disabled),
          JSON.stringify(node.health),
        );
        if (node.disabled)
          sql.exec("DELETE FROM proxy_bindings WHERE proxy_id = ?", node.id);
      }
    }
    if (plan.updateNodes || plan.metadata.revision !== previous?.revision)
      sql.exec(
        "INSERT INTO proxy_metadata (id, revision, strategy, signature) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, strategy = excluded.strategy, signature = excluded.signature",
        plan.metadata.revision,
        plan.metadata.strategy,
        plan.metadata.signature,
      );
    return result;
  }

  select(value: unknown): ProxySelection {
    const { group, owner, exclude } = proxySelectInputSchema.parse(value);
    return this.ctx.storage.transactionSync(() => {
      const synced = this.sync(group);
      if (synced.status === "stale_configuration") return synced;
      const now = Date.now();
      const nodes = this.rows().map((node) => ({
        ...node,
        disabled: !!node.disabled,
        health: this.health(node, now),
      }));
      const key = proxyOwnerKey(owner);
      const bound =
        group.strategy === ProxyStrategy.Sticky
          ? this.ctx.storage.sql
              .exec<{ proxy_id: string }>(
                "SELECT proxy_id FROM proxy_bindings WHERE owner = ?",
                key,
              )
              .toArray()[0]?.proxy_id
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
        this.ctx.storage.sql.exec(
          "DELETE FROM proxy_bindings WHERE owner = ?",
          key,
        );
        if (plan.selection.status === "selected")
          this.ctx.storage.sql.exec(
            "INSERT INTO proxy_bindings (owner, provider_id, credential_id, proxy_id, created_at) VALUES (?, ?, ?, ?, ?)",
            key,
            owner.provider_id,
            owner.credential_id ?? null,
            plan.selection.lease.proxy_id,
            now,
          );
      }
      return plan.selection;
    });
  }

  observe(value: unknown): void {
    const event = proxyOutcomeSchema.parse(value);
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<NodeRow>(
          "SELECT * FROM proxy_nodes WHERE id = ?",
          event.lease.proxy_id,
        )
        .toArray()[0];
      if (!row || row.disabled) {
        return;
      }
      const previous = storedProxyHealthSchema.parse(JSON.parse(row.health));
      const next = observeProxyHealth(previous, event, Date.now());
      if (JSON.stringify(next) === row.health) {
        return;
      }
      this.saveHealth(row.id, next);
      if (next.cooling_until !== null) {
        this.ctx.storage.sql.exec(
          "DELETE FROM proxy_bindings WHERE proxy_id = ?",
          row.id,
        );
      }
    });
  }

  getStatus(value: unknown): ProxyGroupStatus {
    const group = proxyGroupSnapshotSchema.parse(value);
    return this.ctx.storage.transactionSync(() => {
      if (this.sync(group).status === "stale_configuration") {
        throw new Error("Proxy configuration is stale");
      }
      const now = Date.now();
      return proxyGroupStatusSchema.parse({
        group_id: group.id,
        proxies: this.rows().map((node) => {
          const health = this.health(node, now);
          return {
            id: node.id,
            status: node.disabled
              ? "disabled"
              : health.cooling_until !== null
                ? "cooling"
                : "healthy",
            failures: health.failures.length,
            cooling_until: health.cooling_until,
          };
        }),
        bindings: this.ctx.storage.sql
          .exec(
            "SELECT provider_id, credential_id, proxy_id, created_at FROM proxy_bindings ORDER BY owner",
          )
          .toArray()
          .map((row) => ({
            ...row,
            ...(row.credential_id === null ? { credential_id: undefined } : {}),
          })),
      });
    });
  }

  clear(value: unknown, proxyId: string): boolean {
    const group = proxyGroupSnapshotSchema.parse(value);
    const id = identifierSchema.parse(proxyId);
    return this.ctx.storage.transactionSync(() => {
      if (this.sync(group).status === "stale_configuration") {
        throw new Error("Proxy configuration is stale");
      }
      if (!group.proxies.some((node) => node.id === id)) {
        return false;
      }
      this.saveHealth(id, freshProxyHealth());
      return true;
    });
  }
}
