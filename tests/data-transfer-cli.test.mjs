import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openState } from "../scripts/transfer-state.mjs";
import { main } from "../scripts/transfer-data.mjs";
import {
  newState,
  transferInstances,
  abortTransfer,
} from "../src/transfer/runner.ts";
import { endpointIdentity } from "../scripts/transfer-endpoint.mjs";
import { readTransferJson } from "../src/transfer/transport.ts";
import {
  MAX_TRANSFER_BYTES,
  commandSchema,
  parseTransferResult,
} from "../src/transfer/protocol.ts";
import { CloudflareTransfer } from "../scripts/transfer-cloudflare.mjs";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("local checkpoints survive reopening, exclude row data, and reject simultaneous owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-transfer-state-test-"));
  const id = crypto.randomUUID();
  try {
    const journal = await openState(
      directory,
      id,
      newState(id, "source-hash", "target-hash", "schema-hash"),
    );
    await journal.save();
    journal.state.phase = "tables";
    journal.state.cursor = ["9007199254740993"];
    journal.state.intent = "a".repeat(64);
    await journal.save();
    assert.equal((await stat(journal.filename)).mode & 0o777, 0o600);
    await assert.rejects(openState(directory, id), /Another CLI process/);
    const expected = structuredClone(journal.state);
    await journal.close();
    await writeFile(
      `${journal.filename}.lock`,
      JSON.stringify({ host: hostname(), pid: 2147483647 }),
    );
    const resumed = await openState(directory, id);
    assert.deepEqual(resumed.state, expected);
    assert.deepEqual(
      JSON.parse(await readFile(resumed.filename, "utf8")),
      expected,
    );
    await resumed.close();
    await writeFile(journal.filename, "corrupt");
    await assert.rejects(openState(directory, id), /missing or invalid/);
    await assert.rejects(
      openState(directory, crypto.randomUUID()),
      /missing or invalid/,
    );
    assert.deepEqual(await readdir(directory), [`${id}.json`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted abort is persisted before restoring alarms and can only finish aborting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-transfer-abort-test-"));
  const id = crypto.randomUUID();
  const ref = { kind: "oauth", name: crypto.randomUUID() };
  const initial = newState(id, "source", "target", "schema");
  initial.phase = "tables";
  initial.objects = [ref];
  initial.alarms[`oauth:${ref.name}`] = 123456;
  let journal;
  let alarm = null;
  let loseAck = true;
  const target = {
    call: async (command) => {
      assert.deepEqual(command, { action: "schedule", ref, alarm: null });
      return { ok: true };
    },
  };
  const source = {
    call: async (command) => {
      assert.equal(
        JSON.parse(await readFile(journal.filename, "utf8")).phase,
        "aborting",
      );
      assert.deepEqual(command, { action: "schedule", ref, alarm: 123456 });
      alarm = command.alarm;
      if (loseAck) {
        loseAck = false;
        throw new Error("Lost schedule ACK");
      }
      return { ok: true };
    },
  };
  try {
    journal = await openState(directory, id, initial);
    await journal.save();
    await assert.rejects(
      abortTransfer(source, target, journal),
      /Lost schedule ACK/,
    );
    assert.equal(alarm, 123456);
    await journal.close();
    journal = await openState(directory, id);
    assert.equal(journal.state.phase, "aborting");
    await assert.rejects(
      transferInstances(source, target, journal),
      /use --abort/,
    );
    await abortTransfer(source, target, journal);
    assert.equal(
      JSON.parse(await readFile(journal.filename, "utf8")).phase,
      "aborted",
    );
    await assert.rejects(
      transferInstances(source, target, journal),
      /was aborted/,
    );
  } finally {
    await journal?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort cannot restore any alarm when recording the decision fails", async () => {
  const state = newState(crypto.randomUUID(), "source", "target", "schema");
  state.objects = [{ kind: "oauth", name: "account" }];
  state.alarms["oauth:account"] = 123456;
  const endpoint = {
    call: async () =>
      assert.fail("Scheduling must follow durable abort intent"),
  };
  await assert.rejects(
    abortTransfer(endpoint, endpoint, {
      state,
      save: async () => {
        throw new Error("Disk full");
      },
    }),
    /Disk full/,
  );
});

test("endpoint identity survives credential rotation and SQLite path aliases", async () => {
  assert.equal(
    await endpointIdentity(
      "postgres",
      "postgresql://alice:old@localhost:5432/cody?sslmode=require",
    ),
    await endpointIdentity(
      "postgres",
      "postgres://bob:new@localhost/cody?sslmode=require",
    ),
  );
  assert.notEqual(
    await endpointIdentity("postgres", "postgres://alice:old@localhost/cody"),
    await endpointIdentity("postgres", "postgres://alice:old@localhost/other"),
  );
  await assert.rejects(
    endpointIdentity("postgres", "postgres://alice:old@localhost"),
    /name the database/,
  );
  assert.equal(
    await endpointIdentity("libsql", "libsql://example.turso.io?authToken=old"),
    await endpointIdentity("libsql", "libsql://example.turso.io?authToken=new"),
  );
  const directory = await mkdtemp(
    join(tmpdir(), "cody-transfer-identity-test-"),
  );
  try {
    const database = join(directory, "db.sqlite"),
      alias = join(directory, "alias.sqlite");
    await writeFile(database, "");
    await symlink(database, alias);
    assert.equal(
      await endpointIdentity("sqlite", `sqlite:${database}`),
      await endpointIdentity("sqlite", `sqlite:${alias}`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transfer replies reject missing counts and malformed pages without leaking their contents", () => {
  for (const [action, value] of [
    ["preflight", { key_proof: "private-key" }],
    [
      "read",
      { rows: [], next_cursor: null, digest: "corrupted-private-content" },
    ],
    ["write", { ok: false }],
  ]) {
    assert.throws(() => parseTransferResult(action, value), {
      message: `Invalid transfer response: ${action}`,
    });
  }
  assert.equal(
    commandSchema.safeParse({ action: "drain", shard: 0 }).success,
    false,
  );
});

test("transfer transport bounds streamed JSON and cancels oversized replies", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_TRANSFER_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      readTransferJson(
        new Response(body, {
          headers: declared
            ? { "content-length": String(MAX_TRANSFER_BYTES + 1) }
            : {},
        }),
      ),
      /exceeds the size limit/,
    );
    assert.equal(cancelled, true);
  }
  await assert.rejects(readTransferJson(new Response("private-invalid-json")), {
    message: "Transfer response is invalid JSON or exceeds the size limit",
  });
  assert.deepEqual(await readTransferJson(Response.json({ ok: true })), {
    ok: true,
  });
});

test("CLI dry-run checks keys/fresh targets without creating task files or changing SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-transfer-cli-test-"));
  const source = join(directory, "source.sqlite"),
    target = join(directory, "target.sqlite");
  const env = {
    CONFIG_ENCRYPTION_KEY: KEY,
    SOURCE_DATABASE_URL: `sqlite:${source}`,
    TARGET_DATABASE_URL: `sqlite:${target}`,
  };
  const args = [
    "--from",
    "sqlite",
    "--to",
    "sqlite",
    "--state-dir",
    join(directory, "state"),
  ];
  try {
    for (const path of [source, target]) {
      const db = await createSqliteDatabase(path);
      await applyMigrations(db, migrationDirectories("sqlite", ROOT));
      db.close();
    }
    const before = await readFile(target);
    await main([...args, "--dry-run"], env);
    assert.deepEqual(await readFile(target), before);
    assert.ok(!(await readdir(directory)).includes("state"));
    await assert.rejects(
      main([...args, "--dry-run"], {
        ...env,
        TARGET_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      }),
      /CONFIG_ENCRYPTION_KEY differs/,
    );
    await assert.rejects(
      main([...args, "--dry-run"], {
        ...env,
        TARGET_DATABASE_URL: env.SOURCE_DATABASE_URL,
      }),
      /same database/,
    );
    await main([...args, "--yes"], env);
    const [filename] = await readdir(join(directory, "state"));
    const state = JSON.parse(
      await readFile(join(directory, "state", filename), "utf8"),
    );
    assert.equal(state.phase, "completed");
    assert.ok(!JSON.stringify(state).includes(KEY));
    await main([...args, "--yes", "--resume", state.id], env);
    await assert.rejects(
      main([...args, "--yes", "--abort", state.id], env),
      /enabled/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const cfEnv = {
  SOURCE_CLOUDFLARE_API_TOKEN: "mock-private-api-token",
  SOURCE_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  SOURCE_CLOUDFLARE_WORKER: "cody-source",
};
const cfConnection = {
  account: cfEnv.SOURCE_CLOUDFLARE_ACCOUNT_ID,
  worker: cfEnv.SOURCE_CLOUDFLARE_WORKER,
  authorizationHeaders: async () => ({
    authorization: `Bearer ${cfEnv.SOURCE_CLOUDFLARE_API_TOKEN}`,
  }),
};
const response = (result, result_info) =>
  Response.json({
    success: true,
    result,
    ...(result_info ? { result_info } : {}),
  });

test("Cloudflare preflight needs only database and OAuth access, with no queue operations", async () => {
  const calls = [];
  const bindings = ["PROVIDER_OAUTH_ACCOUNT", "HEALTH"].map((name) => ({
    name,
    type: "durable_object_namespace",
    namespace_id: name,
    class_name: name,
  }));
  const cf = new CloudflareTransfer(cfConnection, async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    if (url.endsWith("/settings")) return response({ bindings });
    assert.match(url, /PROVIDER_OAUTH_ACCOUNT\/objects/);
    return response([]);
  });
  await cf.preflight();
  await cf.preflight(true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.includes("/queues")));
});

test("CLI failure guidance distinguishes preflight from an existing transfer", async () => {
  const args = ["--from", "sqlite", "--to", "postgres"];
  await assert.rejects(main(args, {}), (error) => {
    assert.match(error.message, /No transfer data was written/);
    assert.doesNotMatch(
      error.message,
      /state file|--resume|Keep both deployments stopped/,
    );
    return true;
  });
  const id = crypto.randomUUID();
  await assert.rejects(main([...args, "--resume", id], {}), (error) => {
    assert.ok(error.message.includes(`--resume ${id}`));
    assert.match(error.message, /Keep both deployments stopped/);
    assert.doesNotMatch(error.message, /No transfer data was written/);
    return true;
  });
});

test("CLI names the endpoint whose schema check failed without creating a task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-transfer-preflight-"));
  const sourcePath = join(directory, "source.db");
  const targetPath = join(directory, "target.db");
  const args = [
    "--from",
    "sqlite",
    "--to",
    "sqlite",
    "--dry-run",
    "--state-dir",
    join(directory, "tasks"),
  ];
  const env = {
    CONFIG_ENCRYPTION_KEY: KEY,
    SOURCE_DATABASE_URL: `sqlite:${sourcePath}`,
    TARGET_DATABASE_URL: `sqlite:${targetPath}`,
  };
  try {
    for (const path of [sourcePath, targetPath])
      (await createSqliteDatabase(path)).close();
    await assert.rejects(
      main(args, env),
      /Source: preflight: database schema: Missing table/,
    );
    const source = await createSqliteDatabase(sourcePath);
    try {
      await applyMigrations(source, migrationDirectories("sqlite", ROOT));
    } finally {
      source.close();
    }
    await assert.rejects(
      main(args, env),
      /Target: preflight: database schema: Missing table/,
    );
    assert.ok(!(await readdir(directory)).includes("tasks"));
    const target = await createSqliteDatabase(targetPath);
    try {
      assert.deepEqual(
        (
          await target
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
        ).results,
        [],
      );
    } finally {
      target.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare enumerates every OAuth page", async () => {
  const cf = new CloudflareTransfer(cfConnection, async (url) =>
    url.includes("cursor=")
      ? response([{ id: "b".repeat(64), hasStoredData: true }])
      : response([{ id: "a".repeat(64), hasStoredData: true }], {
          cursors: { after: "page-2" },
        }),
  );
  cf.namespaces = { PROVIDER_OAUTH_ACCOUNT: "oauth" };
  const ids = [];
  for await (const object of cf.objects("PROVIDER_OAUTH_ACCOUNT"))
    ids.push(object.id);
  assert.deepEqual(ids, ["a".repeat(64), "b".repeat(64)]);
});

test("Cloudflare reports leftover objects without reading, deleting or migrating them", async () => {
  const cf = new CloudflareTransfer(cfConnection, async (_url, options) => {
    assert.equal(options.method, "GET");
    return response([
      { id: "a".repeat(64), hasStoredData: true },
      { id: "b".repeat(64), hasStoredData: true },
      { id: "c".repeat(64), hasStoredData: false },
    ]);
  });
  const refs = [{ kind: "oauth", name: crypto.randomUUID() }];
  const endpoint = {
    call: async (command) => {
      assert.deepEqual(command, { action: "object_ids", refs });
      return { ids: ["a".repeat(64)] };
    },
  };
  cf.namespaces = {
    PROVIDER_OAUTH_ACCOUNT: "oauth",
    HEALTH: "health",
    PROXY_GROUP: "proxy",
  };
  assert.deepEqual(await cf.countUnmappedObjects(endpoint, refs), {
    PROVIDER_OAUTH_ACCOUNT: 1,
  });
});

test("Cloudflare enumeration rejects unknown storage presence and repeated cursors", async () => {
  let invalid = true;
  const cf = new CloudflareTransfer(cfConnection, async () =>
    invalid
      ? response([{ id: "a".repeat(64) }])
      : response([], { cursors: { after: "repeated" } }),
  );
  cf.namespaces = { PROVIDER_OAUTH_ACCOUNT: "namespace" };
  const list = async () => {
    for await (const _ of cf.objects("PROVIDER_OAUTH_ACCOUNT")) {
      /* consume */
    }
  };
  await assert.rejects(list(), /Invalid Cloudflare/);
  invalid = false;
  await assert.rejects(list(), /repeated its page cursor/);
});

test("temporary Cloudflare bindings refer to the selected deployed resources", async () => {
  const cf = new CloudflareTransfer(cfConnection);
  cf.bindings = [
    { type: "d1", name: "CODY_DB", id: "database-id" },
    {
      type: "durable_object_namespace",
      name: "HEALTH",
      class_name: "ProviderHealth",
    },
    { type: "queue", name: "USAGE_QUEUE", queue_name: "usage" },
  ];
  const config = cf.bridgeConfig();
  assert.equal(config.d1_databases[0].preview_database_id, "database-id");
  assert.equal(config.durable_objects.bindings[0].script_name, "cody-source");
  assert.equal(config.workers_dev, false);
  assert.equal(config.queues, undefined);
  assert.ok(
    !JSON.stringify(config).includes(cfEnv.SOURCE_CLOUDFLARE_API_TOKEN),
  );
});
