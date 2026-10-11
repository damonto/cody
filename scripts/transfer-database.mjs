import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, open, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TABLES, TransferError } from "../src/transfer/protocol.ts";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import { TransferService } from "../src/transfer/service.ts";
import { standardTransferObjects } from "../src/transfer/standard.ts";
import { runWrangler } from "./transfer-wrangler.mjs";

/** Native SQLite parses the dump, including multiline strings and exact int64s. */
export async function loadSqliteDump(sqlFile, databaseFile) {
  const input = await open(sqlFile, "r");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "sqlite3",
        ["-batch", "-bail", "-safe", "-init", "/dev/null", databaseFile],
        {
          stdio: [input.fd, "ignore", "ignore"],
        },
      );
      child.once("error", () =>
        reject(
          new TransferError(
            "Cannot run sqlite3; install the SQLite CLI for D1 transfers",
          ),
        ),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new TransferError(
                "Cannot load the D1 SQL export into temporary SQLite storage",
              ),
            ),
      );
    });
  } finally {
    await input.close();
  }
}

function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (value.includes("\0"))
    return `CAST(X'${Buffer.from(value).toString("hex")}' AS TEXT)`;
  return `'${value.replaceAll("'", "''")}'`;
}

/** Stream only business data, in dependency order, into one native D1 import. */
export async function writeD1Import(source, filename, onProgress = () => {}) {
  const file = await open(filename, "w", 0o600);
  const digest = createHash("sha256");
  const emit = async (sql) => {
    digest.update(sql);
    await file.writeFile(sql);
  };
  try {
    await emit("PRAGMA defer_foreign_keys=ON;\n");
    // Replaying a lost import acknowledgement replaces this task's business
    // data only. Deployment migration records and object tables remain intact.
    for (const table of [...TABLES].reverse())
      await emit(`DELETE FROM ${table};\n`);
    for (const table of TABLES) {
      // Requests trigger temporary aggregates; the source rollups replace them.
      if (table === "usage_hourly") await emit("DELETE FROM usage_hourly;\n");
      let cursor = null,
        count = 0;
      do {
        const page = await source.call({ action: "read", table, cursor });
        if (page.rows.length) {
          const names = Object.keys(page.rows[0]);
          if (names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)))
            throw new TransferError(`Unsupported column in ${table}`);
          const prefix = `INSERT INTO ${table} (${names.join(",")}) VALUES `;
          let tuples = [],
            bytes = Buffer.byteLength(prefix) + 2;
          for (const row of page.rows) {
            const tuple = `(${names.map((name) => literal(row[name])).join(",")})`;
            const size = Buffer.byteLength(tuple) + 1;
            if (Buffer.byteLength(prefix) + size + 2 > 100_000)
              throw new TransferError(
                `A ${table} row exceeds D1's SQL import statement limit`,
              );
            if (
              tuples.length &&
              (bytes + size > 100_000 || tuples.length === 250)
            ) {
              await emit(`${prefix}${tuples.join(",")};\n`);
              tuples = [];
              bytes = Buffer.byteLength(prefix) + 2;
            }
            tuples.push(tuple);
            bytes += size;
          }
          if (tuples.length) await emit(`${prefix}${tuples.join(",")};\n`);
        }
        count += page.rows.length;
        cursor = page.next_cursor;
      } while (cursor !== null);
      onProgress(`${table}: staged ${count} rows for D1 import`);
    }
    await file.sync();
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

/** All scratch files are private and removed when the CLI closes its endpoint. */
export function d1DatabaseTransfer(cloudflare, env, key, run = runWrangler) {
  let directory, snapshot;
  const setup = async () => {
    if (!directory) {
      directory = await mkdtemp(join(tmpdir(), "cody-transfer-db-"));
      const database = cloudflare.bridgeConfig().d1_databases[0];
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          account_id: cloudflare.account,
          d1_databases: [
            {
              binding: "CODY_DB",
              database_name: "transfer",
              database_id: database.database_id,
            },
          ],
        }),
        { mode: 0o600 },
      );
    }
    return ["--config", join(directory, "wrangler.json")];
  };
  return {
    async databaseSnapshot(onProgress) {
      if (snapshot) return snapshot.endpoint;
      const flags = await setup();
      const sql = join(directory, "export.sql"),
        database = join(directory, "export.sqlite");
      onProgress(
        "Exporting D1 with Wrangler; reading and verifying the export locally",
      );
      await run(
        [
          "d1",
          "export",
          "CODY_DB",
          "--remote",
          "--skip-confirmation",
          "--output",
          sql,
          ...flags,
        ],
        env,
      );
      await loadSqliteDump(sql, database);
      const db = await createSqliteDatabase(database);
      await db.exec("PRAGMA query_only = ON");
      const service = new TransferService(
        { CODY_DB: db, CONFIG_ENCRYPTION_KEY: key },
        standardTransferObjects(db),
        "standard",
      );
      snapshot = {
        db,
        endpoint: {
          call: async (command) => {
            if (command.action !== "read")
              throw new TransferError("D1 database snapshot is read-only");
            return service.execute(command);
          },
        },
      };
      return snapshot.endpoint;
    },
    async importDatabase(source, saveIntent, onProgress) {
      const flags = await setup();
      const sql = join(directory, "import.sql");
      const digest = await writeD1Import(source, sql, onProgress);
      await saveIntent(digest);
      onProgress("Importing D1 with Wrangler");
      await run(
        [
          "d1",
          "execute",
          "CODY_DB",
          "--remote",
          "--file",
          sql,
          "--yes",
          ...flags,
        ],
        env,
      );
    },
    async close() {
      snapshot?.db.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
