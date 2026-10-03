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
  const migration = bindings.TEST_MIGRATIONS.find(
    (migration) => migration.name === name,
  )!;
  await checkNativeDefaults(env.CODY_DB, () =>
    env.CODY_DB.batch(migration.queries.map((sql) => env.CODY_DB.prepare(sql))),
  );
});
