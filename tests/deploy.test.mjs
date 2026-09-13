import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../scripts/deploy.mjs", import.meta.url);
const migration = ["d1", "migrations", "apply", "CODY_DB", "--remote"];
const target = ["--env", "staging", "--config", "config folder/wrangler.jsonc"];

for (const { name, args, statuses, expected, code = 0, errorPattern } of [
  {
    name: "deployment applies migrations before publishing",
    args: [],
    statuses: [0, 0],
    expected: [migration, ["deploy"]],
  },
  {
    name: "migration failure prevents deployment and preserves the failure code",
    args: [],
    statuses: [7],
    expected: [migration],
    code: 7,
  },
  {
    name: "deployment failures propagate after a successful migration",
    args: [],
    statuses: [0, 8],
    expected: [migration, ["deploy"]],
    code: 8,
  },
  {
    name: "an interrupted migration cannot proceed to deployment",
    args: [],
    statuses: [null],
    expected: [migration],
    code: 1,
  },
  {
    name: "dry runs never apply remote migrations",
    args: ["--dry-run"],
    statuses: [0],
    expected: [["deploy", "--dry-run"]],
  },
  {
    name: "migration and deployment use the same environment and config",
    args: ["-e", "staging", "-c", "config folder/wrangler.jsonc"],
    statuses: [0, 0],
    expected: [
      [...migration, ...target],
      ["deploy", ...target],
    ],
  },
  {
    name: "env files are forwarded without shell interpolation",
    args: [
      "--env-file",
      "env files/base.env",
      "--env-file",
      "env files/staging.env",
    ],
    statuses: [0, 0],
    expected: [
      [
        ...migration,
        "--env-file",
        "env files/base.env",
        "--env-file",
        "env files/staging.env",
      ],
      [
        "deploy",
        "--env-file",
        "env files/base.env",
        "--env-file",
        "env files/staging.env",
      ],
    ],
  },
  {
    name: "invalid release flags fail before any remote command",
    args: ["--dryrun"],
    statuses: [],
    expected: [],
    code: 1,
    errorPattern: /Unknown option '--dryrun'/,
  },
]) {
  test(name, async () => {
    const harness = `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const statuses = ${JSON.stringify(statuses)};
      childProcess.spawnSync = (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(options.env.CI, "true");
        assert.notEqual(options.shell, true);
        console.log("RELEASE_CALL " + JSON.stringify(args.slice(1)));
        return { status: statuses.shift() };
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(script))},
        ...${JSON.stringify(args)}];
      await import(${JSON.stringify(script.href)});
    `;
    let result;
    try {
      result = {
        ...(await execute(process.execPath, [
          "--input-type=module",
          "--eval",
          harness,
        ])),
        code: 0,
      };
    } catch (error) {
      result = error;
    }
    assert.equal(result.code, code, result.stderr);
    if (errorPattern) assert.match(result.stderr, errorPattern);
    const calls = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("RELEASE_CALL "))
      .map((line) => JSON.parse(line.slice("RELEASE_CALL ".length)));
    assert.deepEqual(calls, expected);
  });
}
