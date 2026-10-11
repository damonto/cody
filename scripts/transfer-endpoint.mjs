import { fork } from "node:child_process";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import {
  connectDatabase,
  databaseKind,
} from "../src/platform/standard/sql/connect.ts";
import { TransferService } from "../src/transfer/service.ts";
import { standardTransferObjects } from "../src/transfer/standard.ts";
import {
  commandSchema,
  TransferError,
  hash,
  parseTransferResult,
} from "../src/transfer/protocol.ts";
import { CloudflareTransfer } from "./transfer-cloudflare.mjs";
import { resolveCloudflareConnection } from "./transfer-wrangler.mjs";
import { d1DatabaseTransfer } from "./transfer-database.mjs";

/** Credentials can rotate without changing the database a saved task belongs to. */
export async function endpointIdentity(kind, url) {
  if (kind === "sqlite")
    return hash({ kind, path: await realpath(url.slice("sqlite:".length)) });
  const address = new URL(url);
  address.username = "";
  address.password = "";
  for (const name of ["authToken", "password", "user", "username"])
    address.searchParams.delete(name);
  if (kind === "postgres") {
    if (!address.pathname || address.pathname === "/")
      throw new TransferError(
        "PostgreSQL transfer connections must name the database explicitly",
      );
    address.protocol = "postgres:";
    if (address.port === "5432") address.port = "";
  }
  address.searchParams.sort();
  return hash({ kind, address: address.href });
}

export async function openEndpoint(
  kind,
  prefix,
  env = process.env,
  { fresh = false, config, env: wranglerEnv } = {},
) {
  const key =
    env[`${prefix}_CONFIG_ENCRYPTION_KEY`] ?? env.CONFIG_ENCRYPTION_KEY;
  if (!key || Buffer.from(key, "base64").length !== 32)
    throw new TransferError(
      `Set ${prefix}_CONFIG_ENCRYPTION_KEY to the deployment's base64 32-byte key`,
    );
  if (kind !== "cloudflare") {
    if (!["sqlite", "postgres", "libsql"].includes(kind))
      throw new TransferError(
        "Endpoints must be cloudflare, sqlite, postgres or libsql; pass connection credentials through environment variables",
      );
    const url = env[`${prefix}_DATABASE_URL`];
    if (!url || databaseKind(url) !== kind)
      throw new TransferError(`Set ${prefix}_DATABASE_URL for ${kind}`);
    // Preflight must not create a database or migrate it implicitly.
    const identity = await endpointIdentity(kind, url);
    const db = await connectDatabase(url, { max: 1 });
    const bindings = { CODY_DB: db, CONFIG_ENCRYPTION_KEY: key };
    const service = new TransferService(
      bindings,
      standardTransferObjects(db),
      "standard",
    );
    return {
      identity,
      call: (command) => service.execute(commandSchema.parse(command)),
      close: () => db.close(),
    };
  }
  const connection = await resolveCloudflareConnection(prefix, env, {
    config,
    env: wranglerEnv,
  });
  const cloudflare = new CloudflareTransfer(connection);
  await cloudflare.preflight(fresh);
  const bridgeConfig = cloudflare.bridgeConfig();
  const child = fork(
    new URL("./transfer-cloudflare-session.mjs", import.meta.url),
    {
      env: {
        ...connection.env,
        TRANSFER_KEY: key,
        BRIDGE_TOKEN: crypto.randomUUID(),
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG: "none",
        WRANGLER_WRITE_LOGS: "false",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const pending = new Map();
  child.on("message", (message) => {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new TransferError(message.error));
    else operation.resolve(message.result);
  });
  const failed = () => {
    for (const operation of pending.values())
      operation.reject(
        new TransferError(
          "Cloudflare binding session disconnected; resume the recorded task",
        ),
      );
    pending.clear();
  };
  child.on("exit", failed);
  child.on("error", failed);
  const send = (message) =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(new TransferError("Cloudflare binding session disconnected"));
        return;
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(
          new TransferError(
            "Cloudflare binding session timed out; resume the recorded task",
          ),
        );
      }, 120_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ id, ...message });
    });
  const close = async () => {
    if (
      !child.connected ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const exited = once(child, "exit");
    child.send({ action: "close" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await send({ action: "start", config: bridgeConfig });
  } catch (error) {
    await close();
    throw error;
  }
  const database = d1DatabaseTransfer(cloudflare, connection.env, key);
  const call = async (value) => {
    const command = commandSchema.parse(value);
    const result = parseTransferResult(
      command.action,
      await send({ action: "call", command }),
    );
    if (command.action === "inventory")
      result.skipped = await cloudflare.countUnmappedObjects(
        { call },
        result.objects,
      );
    return result;
  };
  return {
    identity: await hash({
      account: cloudflare.account,
      database: cloudflare.bindings.find((b) => b.name === "CODY_DB")?.id,
    }),
    call,
    databaseSnapshot: database.databaseSnapshot,
    importDatabase: database.importDatabase,
    close: async () => {
      try {
        await database.close();
      } finally {
        await close();
      }
    },
  };
}
