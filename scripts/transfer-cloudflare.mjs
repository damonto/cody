import { z } from "zod";
import { TransferError } from "../src/transfer/protocol.ts";
import { readTransferJson } from "../src/transfer/transport.ts";
import { discardBody } from "../src/gateway/http/body.ts";

const resourceId = z.string().min(1);
const objectsSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    hasStoredData: z.boolean(),
  }),
);
const envelopeSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
  result_info: z
    .object({
      total_pages: z.number().int().nonnegative().optional(),
      cursors: z.object({ after: z.string().nullable().optional() }).optional(),
      cursor: z.string().nullable().optional(),
    })
    .optional(),
});
const objectBindings = ["PROVIDER_OAUTH_ACCOUNT", "HEALTH"];

function validated(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new TransferError("Invalid Cloudflare control-plane response");
  return result.data;
}

/** Cloudflare control-plane discovery stays on the operator's machine. */
export class CloudflareTransfer {
  constructor({ account, worker, authorizationHeaders }, fetcher = fetch) {
    this.account = account;
    this.worker = worker;
    this.authorizationHeaders = authorizationHeaders;
    this.fetcher = fetcher;
  }

  async api(path, body, method = body === undefined ? "GET" : "POST") {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`,
        {
          method,
          headers: {
            ...(await this.authorizationHeaders(attempt > 0)),
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        await discardBody(response.body);
        // A rejected authorization has no side effects. Let Wrangler refresh OAuth
        // credentials before retrying; never retry a failed business operation here.
        if (response.status === 401 && attempt === 0) continue;
        throw new TransferError(
          `Cloudflare control-plane request failed (${response.status})`,
        );
      }
      if (method === "DELETE" && response.status === 204)
        return { success: true, result: null };
      return validated(envelopeSchema, await readTransferJson(response));
    }
  }

  async preflight(emptyTarget = false) {
    const { result } = await this.api(
      `/workers/scripts/${encodeURIComponent(this.worker)}/settings`,
    );
    const { bindings } = validated(
      z.object({
        bindings: z.array(
          z.looseObject({ name: z.string(), type: z.string() }),
        ),
      }),
      result,
    );
    this.bindings = bindings;
    this.namespaces = Object.fromEntries(
      bindings
        .filter((b) => b.type === "durable_object_namespace")
        .map((b) => {
          const binding = validated(
            z.object({
              name: z.string(),
              namespace_id: resourceId,
              class_name: z.string(),
            }),
            b,
          );
          return [binding.name, binding.namespace_id];
        }),
    );
    for (const name of objectBindings)
      if (!this.namespaces[name])
        throw new TransferError(`Missing Durable Object namespace: ${name}`);
    if (emptyTarget)
      for await (const object of this.objects("PROVIDER_OAUTH_ACCOUNT"))
        if (object.hasStoredData)
          throw new TransferError("Target contains OAuth accounts");
  }

  bridgeConfig() {
    const database = this.bindings.find(
      (b) => b.type === "d1" && b.name === "CODY_DB",
    );
    if (!database?.id) throw new TransferError("Worker must bind CODY_DB");
    return {
      name: `cody-transfer-${crypto.randomUUID()}`,
      account_id: this.account,
      compatibility_date: "2026-09-01",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      send_metrics: false,
      d1_databases: [
        {
          binding: "CODY_DB",
          database_id: database.id,
          preview_database_id: database.id,
          database_name: "transfer",
        },
      ],
      durable_objects: {
        bindings: this.bindings
          .filter(
            (b) =>
              b.type === "durable_object_namespace" &&
              objectBindings.includes(b.name),
          )
          .map((b) => ({
            name: b.name,
            class_name: b.class_name,
            script_name: b.script_name ?? this.worker,
            ...(b.environment ? { environment: b.environment } : {}),
          })),
      },
    };
  }

  async *objects(binding) {
    let cursor;
    const visited = new Set();
    do {
      const result = await this.api(
        `/workers/durable_objects/namespaces/${this.namespaces[binding]}/objects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      for (const value of validated(objectsSchema, result.result)) yield value;
      cursor = result.result_info?.cursors?.after ?? result.result_info?.cursor;
      if (cursor && visited.has(cursor))
        throw new TransferError(
          "Cloudflare object listing repeated its page cursor",
        );
      if (cursor) visited.add(cursor);
    } while (cursor);
  }

  async countUnmappedObjects(endpoint, refs) {
    const ids = new Set();
    for (let offset = 0; offset < refs.length; offset += 50) {
      const page = await endpoint.call({
        action: "object_ids",
        refs: refs.slice(offset, offset + 50),
      });
      for (const id of page.ids) ids.add(id);
    }
    const counts = {};
    for (const binding of ["PROVIDER_OAUTH_ACCOUNT"]) {
      for await (const object of this.objects(binding)) {
        if (object.hasStoredData && !ids.has(object.id))
          counts[binding] = (counts[binding] ?? 0) + 1;
      }
    }
    // D1 may have been rebuilt while the namespace still contains older objects.
    // The SQL/history inventory owns migration scope; leave other objects alone.
    return counts;
  }
}
