import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { test } from "vitest";
import { checkNativeDefaults } from "../helpers/native-provider-defaults.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
test("D1 native defaults preserve settings and history and allow the first account", async () => {
  const name = "0015_native_provider_defaults.sql";
  await applyD1Migrations(
    env.CODY_DB,
    bindings.TEST_MIGRATIONS.filter((migration) => migration.name < name),
  );
  const migrations = bindings.TEST_MIGRATIONS.filter(
    (migration) =>
      migration.name === name ||
      migration.name === "0016_remove_history_notes.sql",
  );
  await checkNativeDefaults(env.CODY_DB, () =>
    env.CODY_DB.batch(
      migrations.flatMap((migration) =>
        migration.queries.map((sql) => env.CODY_DB.prepare(sql)),
      ),
    ),
  );
});
