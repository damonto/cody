import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify, parseEnv } from "node:util";

const execute = promisify(execFile);
const script = new URL("../scripts/setup-local.mjs", import.meta.url);
const key = Buffer.alloc(32, 7).toString("base64");
const migration = ["d1", "migrations", "apply", "CODY_DB", "--local"];

async function fixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "cody-local-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, ".dev.vars");
  if (contents !== undefined) await writeFile(file, contents, { mode: 0o600 });
  return { directory, file };
}

async function setup(
  directory,
  {
    stored = 0,
    migrationStatus = 0,
    queryStatus = 0,
    output,
    concurrentSettings,
  } = {},
) {
  const harness = `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    childProcess.spawnSync = (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(options.env.CI, "true");
      assert.notEqual(options.shell, true);
      const operation = args.slice(1);
      assert.ok(operation.includes("--local"));
      assert.ok(!operation.includes("--remote"));
      console.log("LOCAL_CALL " + JSON.stringify(operation));
      if (operation[1] === "migrations") {
        const concurrentSettings = ${JSON.stringify(concurrentSettings)};
        if (concurrentSettings !== undefined) writeFileSync(".dev.vars", concurrentSettings);
        return { status: ${JSON.stringify(migrationStatus)} };
      }
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return {
        status: ${JSON.stringify(queryStatus)},
        stdout: ${JSON.stringify(output ?? JSON.stringify([{ success: true, results: [{ has_encrypted_data: stored }] }]))},
        stderr: "",
      };
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(script.href)});
  `;
  let result;
  try {
    result = {
      ...(await execute(
        process.execPath,
        ["--input-type=module", "--eval", harness],
        { cwd: directory },
      )),
      code: 0,
    };
  } catch (error) {
    result = error;
  }
  const calls = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("LOCAL_CALL "))
    .map((line) => JSON.parse(line.slice("LOCAL_CALL ".length)));
  return { ...result, calls };
}

test("npm dev prepares local storage before building and starting the Worker", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    scripts.dev,
    "npm run dev:setup && npm run build:web && wrangler dev --local",
  );
});

test("fresh local setup creates a private key only after migrating and checking storage", async (t) => {
  const { directory, file } = await fixture(t);
  const result = await setup(directory);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls[0], migration);
  assert.deepEqual(result.calls[1].slice(0, 6), [
    "d1",
    "execute",
    "CODY_DB",
    "--local",
    "--json",
    "--command",
  ]);
  for (const table of [
    "control_state",
    "config_revisions",
    "oauth_clients",
    "oauth_accounts",
  ])
    assert.ok(result.calls[1][6].includes(table));
  const contents = await readFile(file, "utf8");
  const settings = parseEnv(contents);
  assert.equal(atob(settings.CONFIG_ENCRYPTION_KEY).length, 32);
  assert.equal(settings.ADMIN_LOCAL_DEV, "true");
  assert.ok(!result.stdout.includes(settings.CONFIG_ENCRYPTION_KEY));
  assert.ok(!result.stderr.includes(settings.CONFIG_ENCRYPTION_KEY));
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);

  const again = await setup(directory);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.calls, [migration]);
  assert.equal(await readFile(file, "utf8"), contents);
});

test("setup preserves quoted keys, comments and an explicit local access setting", async (t) => {
  const contents = `# Keep these settings\nexport CONFIG_ENCRYPTION_KEY = "${key}"\nADMIN_LOCAL_DEV=false\n`;
  const { directory, file } = await fixture(t, contents);
  const result = await setup(directory, { stored: 1 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, [migration]);
  assert.equal(await readFile(file, "utf8"), contents);
});

test("setup appends missing local access without rewriting an existing key", async (t) => {
  const contents = `CONFIG_ENCRYPTION_KEY=${key}`;
  const { directory, file } = await fixture(t, contents);
  const result = await setup(directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await readFile(file, "utf8"),
    `${contents}\nADMIN_LOCAL_DEV=true\n`,
  );
});

for (const invalid of [
  "",
  "not-a-valid-key",
  Buffer.alloc(16).toString("base64"),
]) {
  test(`invalid local key (${invalid.length} characters) fails without changing settings`, async (t) => {
    const contents = `CONFIG_ENCRYPTION_KEY="${invalid}"\n`;
    const { directory, file } = await fixture(t, contents);
    const result = await setup(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /base64-encoded 32-byte key/);
    if (invalid) assert.ok(!result.stderr.includes(invalid));
    assert.deepEqual(result.calls, []);
    assert.equal(await readFile(file, "utf8"), contents);
  });
}

test("missing keys cannot be regenerated over existing configuration or OAuth data", async (t) => {
  const contents = `ADMIN_LOCAL_DEV=true\nCONFIG_ENCRYPTION_KEY_PROD=${key}\n`;
  const { directory, file } = await fixture(t, contents);
  const result = await setup(directory, { stored: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Restore the original key/);
  assert.ok(!result.stderr.includes(key));
  assert.equal(await readFile(file, "utf8"), contents);
});

for (const [name, options, expectedCode, callCount] of [
  ["failed migrations", { migrationStatus: 7 }, 7, 1],
  ["interrupted migrations", { migrationStatus: null }, 1, 1],
  ["failed storage checks", { queryStatus: 8 }, 8, 2],
  ["malformed storage replies", { output: "not-json" }, 1, 2],
  ["unexpected storage replies", { output: "[]" }, 1, 2],
  [
    "unsuccessful storage replies",
    { output: '[{"success":false,"results":[{"has_encrypted_data":0}]}]' },
    1,
    2,
  ],
]) {
  test(`${name} stop setup without generating secrets`, async (t) => {
    const { directory, file } = await fixture(t);
    const result = await setup(directory, options);
    assert.equal(result.code, expectedCode);
    assert.equal(result.calls.length, callCount);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  });
}

test("settings edited while migrations run are never replaced or duplicated", async (t) => {
  const contents = `CONFIG_ENCRYPTION_KEY=${key}\n`;
  const { directory, file } = await fixture(t, contents);
  const updated = `${contents}ADMIN_LOCAL_DEV=false\n`;
  const result = await setup(directory, { concurrentSettings: updated });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changed during setup/);
  assert.equal(await readFile(file, "utf8"), updated);
});
