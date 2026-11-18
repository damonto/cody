import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { test } from "vitest";
import { checkNativeDefaults } from "../helpers/native-provider-defaults.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
test("D1 native defaults preserve settings and history and allow the first account", async () => {
  await checkNativeDefaults(env.CODY_DB, () =>
    applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS),
  );
});
