import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { test } from "vitest";
import { checkConfigurationCleanup } from "../helpers/configuration-cleanup.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
test("D1 entity initialization retires document tables and preserves history atomically", async () => {
  const name = "0012_entity_configuration.sql";
  await applyD1Migrations(
    env.CODY_DB,
    bindings.TEST_MIGRATIONS.filter((migration) => migration.name < name),
  );
  await checkConfigurationCleanup(env.CODY_DB, () =>
    applyD1Migrations(
      env.CODY_DB,
      bindings.TEST_MIGRATIONS.filter((migration) => migration.name === name),
    ),
  );
});
