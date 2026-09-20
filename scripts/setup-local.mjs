import { randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

const wrangler = fileURLToPath(
  new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json")),
);
const localDataSchema = z.tuple([
  z.object({
    success: z.literal(true),
    results: z.tuple([
      z.object({ has_encrypted_data: z.union([z.literal(0), z.literal(1)]) }),
    ]),
  }),
]);
const localDataQuery = `SELECT (
  EXISTS (SELECT 1 FROM control_state WHERE draft_payload IS NOT NULL)
  OR EXISTS (SELECT 1 FROM config_revisions)
  OR EXISTS (SELECT 1 FROM oauth_clients)
  OR EXISTS (SELECT 1 FROM oauth_accounts)
) AS has_encrypted_data`;

async function readSettings() {
  try {
    return await readFile(".dev.vars", "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

function runWrangler(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    // Declining Wrangler's migration prompt can otherwise exit successfully.
    env: { ...process.env, CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function hasEncryptedData() {
  const output = runWrangler(
    [
      "d1",
      "execute",
      "CODY_DB",
      "--local",
      "--json",
      "--command",
      localDataQuery,
    ],
    true,
  );
  try {
    const [result] = localDataSchema.parse(JSON.parse(output));
    return result.results[0].has_encrypted_data === 1;
  } catch {
    throw new Error(
      "Could not check local encrypted data; no key was generated.",
    );
  }
}

try {
  const existing = await readSettings();
  const settings = parseEnv(existing);
  if (settings.CONFIG_ENCRYPTION_KEY !== undefined) {
    let valid = false;
    try {
      valid = atob(settings.CONFIG_ENCRYPTION_KEY).length === 32;
    } catch {
      /* Invalid base64 is reported without exposing the value. */
    }
    if (!valid)
      throw new Error(
        "CONFIG_ENCRYPTION_KEY in .dev.vars must be a base64-encoded 32-byte key. Restore the original key if local data already exists.",
      );
  }

  runWrangler(["d1", "migrations", "apply", "CODY_DB", "--local"]);

  const additions = [];
  if (settings.CONFIG_ENCRYPTION_KEY === undefined) {
    // A replacement key cannot decrypt existing drafts, revisions, or OAuth tokens.
    if (hasEncryptedData())
      throw new Error(
        "Local configuration or OAuth data already exists, but CONFIG_ENCRYPTION_KEY is missing from .dev.vars. Restore the original key; no replacement was generated.",
      );
    additions.push(
      `CONFIG_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    );
  }
  if (settings.ADMIN_LOCAL_DEV === undefined)
    additions.push("ADMIN_LOCAL_DEV=true");
  if (additions.length) {
    if ((await readSettings()) !== existing)
      throw new Error(".dev.vars changed during setup; run the command again.");
    await appendFile(
      ".dev.vars",
      `${existing.endsWith("\n") || !existing ? "" : "\n"}${additions.join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  console.log("Local settings and D1 migrations are ready.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
