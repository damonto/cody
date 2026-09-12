import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

let existing = "";
try {
  existing = await readFile(".dev.vars", "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const additions = [];
if (!/^\s*(?:export\s+)?CONFIG_ENCRYPTION_KEY\s*=/m.test(existing))
  additions.push(`CONFIG_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
if (!/^\s*(?:export\s+)?ADMIN_LOCAL_DEV\s*=/m.test(existing))
  additions.push("ADMIN_LOCAL_DEV=true");
if (additions.length)
  await writeFile(
    ".dev.vars",
    `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${additions.join("\n")}\n`,
    { mode: 0o600 },
  );
console.log(
  "Local settings are ready in .dev.vars (secret values are not displayed).",
);
const processName = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(
  processName,
  ["wrangler", "d1", "migrations", "apply", "CODY_DB", "--local"],
  { stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
