import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const wrangler = fileURLToPath(
  new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json")),
);

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    stdio: "inherit",
    // Wrangler can exit successfully when a migration prompt is declined.
    // Run this publish pipeline non-interactively so migrations cannot be skipped.
    env: { ...process.env, CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      env: { type: "string", short: "e" },
      config: { type: "string", short: "c" },
      "env-file": { type: "string", multiple: true },
    },
  });
  const target = [];
  for (const name of ["env", "config"]) {
    if (values[name] !== undefined) target.push(`--${name}`, values[name]);
  }
  for (const path of values["env-file"] ?? []) target.push("--env-file", path);

  if (!values["dry-run"]) {
    runWrangler([
      "d1",
      "migrations",
      "apply",
      "CODY_DB",
      "--remote",
      ...target,
    ]);
  }
  runWrangler([
    "deploy",
    ...target,
    ...(values["dry-run"] ? ["--dry-run"] : []),
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
