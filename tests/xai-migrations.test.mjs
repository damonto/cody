import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  pgliteQueryable,
  postgresDatabase,
} from "../src/platform/standard/sql/postgres.ts";
for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: xAI migration preserves existing OAuth accounts`, async () => {
    const postgres = dialect === "postgres" ? new PGlite() : undefined;
    const db = postgres
      ? postgresDatabase(pgliteQueryable(postgres))
      : await createSqliteDatabase(":memory:");
    try {
      await db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      const directory = dialect === "sqlite" ? "d1" : "postgres";
      for (const name of [
        "0001_control_and_usage.sql",
        "0007_oauth_accounts.sql",
        "0008_codex_oauth_accounts.sql",
        "0009_claude_oauth_accounts.sql",
      ]) {
        await db.applyMigration(
          await readFile(
            new URL(`../migrations/${directory}/${name}`, import.meta.url),
            "utf8",
          ),
          name,
        );
      }
      for (const provider of ["antigravity", "codex", "claude"]) {
        await db
          .prepare(
            "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(provider, provider, provider, 123)
          .run();
      }
      const name = "0010_xai_oauth_accounts.sql";
      const sql = await readFile(
        new URL(`../migrations/${directory}/${name}`, import.meta.url),
        "utf8",
      );
      assert.equal(await db.applyMigration(sql, name), true);
      assert.equal(await db.applyMigration(sql, name), false);
      await db
        .prepare(
          "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("xai", "xai", "xai", 456)
        .run();
      const rows = (
        await db
          .prepare(
            "SELECT provider_type, created_at FROM oauth_accounts ORDER BY provider_type",
          )
          .all()
      ).results;
      assert.deepEqual(
        rows.map((row) => [row.provider_type, Number(row.created_at)]),
        [
          ["antigravity", 123],
          ["claude", 123],
          ["codex", 123],
          ["xai", 456],
        ],
      );
    } finally {
      if (postgres) await postgres.close();
      else await db.close?.();
    }
  });
}
