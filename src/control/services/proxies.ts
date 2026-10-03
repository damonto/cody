import type { ConfigurationOperation } from "../unit-of-work.ts";
import { z } from "zod";
import { proxyGroupSchema, proxyNodeSchema } from "../../config/schema.ts";
import type { ControlStore } from "../store.ts";
import type { ConfigurationUnitOfWork } from "../unit-of-work.ts";
import type { groupInputSchema, nodeInputSchema } from "../resource-input.ts";
import { proxyTables } from "../repository.ts";
import { groupsFromEntities, live } from "../compiler.ts";
import { maskSecrets } from "../secrets.ts";
import { ControlInputError, required } from "../errors.ts";
import { groupFor, put } from "./shared.ts";

type GroupInput = z.infer<typeof groupInputSchema>;
type NodeInput = z.infer<typeof nodeInputSchema>;
const groupEntity = (work: ConfigurationUnitOfWork, id: string) =>
  required(
    live(work.rows.proxy_groups).find((row) => row.id === id),
    "Proxy group",
  );
const nodeEntity = (
  work: ConfigurationUnitOfWork,
  id: string,
  nodeId: string,
) =>
  required(
    live(work.rows.proxy_nodes).find(
      (row) => row.group_id === id && row.id === nodeId,
    ),
    "Proxy node",
  );
async function writeNode(
  work: ConfigurationUnitOfWork,
  groupId: string,
  input: NodeInput,
  position: number,
  nodeId?: string,
) {
  const old = nodeId ? nodeEntity(work, groupId, nodeId) : undefined;
  const metadata = work.metadata(old);
  put(work.rows.proxy_nodes, {
    ...metadata,
    group_id: groupId,
    name: input.name,
    url: input.url,
    username: input.username ?? null,
    secret_id: input.password
      ? await work.secrets.seal(
          metadata.id,
          "password",
          input.password,
          old?.secret_id,
        )
      : null,
    priority: input.priority,
    disabled: input.disabled ? 1 : 0,
    position,
  });
  return metadata.id;
}
export class ProxyService {
  constructor(private readonly store: ControlStore) {}
  list() {
    return this.store.resource(proxyTables, groupsFromEntities, (items) =>
      items.map((item) => proxyGroupSchema.parse(maskSecrets(item))),
    );
  }

  async get(id: string) {
    const result = await this.list();
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === id),
        "Proxy group",
      ),
    };
  }
  save(operation: ConfigurationOperation, input: GroupInput, id?: string) {
    return this.store.mutate(
      operation,
      async (work) => {
        const old = id ? groupEntity(work, id) : undefined;
        const metadata = work.metadata(old);
        put(work.rows.proxy_groups, {
          ...metadata,
          name: input.name,
          strategy: input.strategy,
          position: old?.position ?? work.rows.proxy_groups.length,
        });
        const retained = new Set<string>();
        for (const [position, node] of input.proxies.entries()) {
          const previous = id
            ? work.rows.proxy_nodes.find((row) => row.id === node.id)
            : undefined;
          if (
            previous &&
            (previous.group_id !== id || previous.deleted_at !== null)
          )
            throw new ControlInputError(
              "A proxy node cannot move to another group",
            );
          retained.add(
            await writeNode(
              work,
              metadata.id,
              { ...node, name: required(node.name, "Proxy node name") },
              position,
              previous?.id,
            ),
          );
        }
        work.rows.proxy_nodes = work.rows.proxy_nodes.filter(
          (row) =>
            row.group_id !== metadata.id ||
            row.deleted_at !== null ||
            retained.has(row.id),
        );
      },
      (config) =>
        id
          ? groupFor(config, id)
          : required(config.proxy_groups.at(-1), "Proxy group"),
    );
  }
  remove(operation: ConfigurationOperation, id: string) {
    return this.store.mutate(
      operation,
      (work) => {
        groupEntity(work, id);
        work.rows.proxy_groups = work.rows.proxy_groups.filter(
          (row) => row.id !== id,
        );
        work.rows.proxy_nodes = work.rows.proxy_nodes.filter(
          (row) => row.group_id !== id,
        );
      },
      () => null,
    );
  }
  async nodes(id: string) {
    const result = await this.get(id);
    return { ...result, item: result.item.proxies };
  }
  async node(id: string, nodeId: string) {
    const result = await this.nodes(id);
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === nodeId),
        "Proxy node",
      ),
    };
  }
  saveNode(
    operation: ConfigurationOperation,
    id: string,
    input: NodeInput,
    nodeId?: string,
  ) {
    return this.store.mutate(
      operation,
      async (work) => {
        groupEntity(work, id);
        const old = nodeId ? nodeEntity(work, id, nodeId) : undefined;
        await writeNode(
          work,
          id,
          input,
          old?.position ?? work.rows.proxy_nodes.length,
          nodeId,
        );
      },
      (config) =>
        required(
          nodeId
            ? groupFor(config, id).proxies.find((row) => row.id === nodeId)
            : groupFor(config, id).proxies.at(-1),
          "Proxy node",
        ),
    );
  }
  removeNode(operation: ConfigurationOperation, id: string, nodeId: string) {
    return this.store.mutate(
      operation,
      (work) => {
        nodeEntity(work, id, nodeId);
        work.rows.proxy_nodes = work.rows.proxy_nodes.filter(
          (row) => row.id !== nodeId,
        );
      },
      () => null,
    );
  }
  connection(id: string, nodeId: string, version: number) {
    return this.store.reveal(
      ["proxy_nodes"],
      version,
      async (rows, secrets) => {
        const row = required(
          live(rows.proxy_nodes).find(
            (row) => row.group_id === id && row.id === nodeId,
          ),
          "Proxy node",
        );
        return proxyNodeSchema.parse({
          id: row.id,
          name: row.name,
          url: row.url,
          priority: row.priority,
          disabled: !!row.disabled,
          ...(row.username === null ? {} : { username: row.username }),
          ...(row.secret_id === null
            ? {}
            : { password: await secrets.read(row.secret_id) }),
        });
      },
    );
  }
}
