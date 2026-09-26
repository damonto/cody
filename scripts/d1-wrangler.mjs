/**
 * Cloudflare D1 as a reporting transfer endpoint, through Wrangler. Reads run
 * as `d1 execute --command` queries, which keep the database serving
 * requests. Writes collect into one SQL file that `d1 execute --file` imports
 * atomically; D1 pauses other queries while an import runs.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(
  new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json")),
);

// D1 rejects statements over 100,000 bytes. Values are inlined, so there is no
// bound-parameter limit.
const D1_LIMITS = { bytes: 90_000, values: Number.POSITIVE_INFINITY };

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new RangeError("SQL numbers must be finite");
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0"))
      throw new RangeError("SQL text cannot contain NUL characters");
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new TypeError(`Unsupported SQL value of type ${typeof value}`);
}

/** Replaces `?` placeholders outside string literals with SQL literals. */
export function inlineSql(sql, values) {
  let output = "";
  let index = 0;
  let quoted = false;
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === "?" && !quoted) {
      if (index >= values.length) throw new Error("Missing SQL value");
      output += sqlLiteral(values[index]);
      index += 1;
    } else {
      output += char;
    }
  }
  if (index !== values.length) throw new Error("Unused SQL values");
  return output;
}

/** Runs Wrangler; captured runs resolve its standard output. */
export function runWrangler(args, { capture }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `wrangler ${args.slice(0, 2).join(" ")} exited with ${code}\n${(stderr || stdout).trim().slice(-2000)}`,
          ),
        );
    });
  });
}

/**
 * A D1 database as a transfer endpoint. `confirm` receives the size of the
 * pending import and decides whether it runs. Reads retry transient Wrangler
 * and network failures; the import is atomic and is left to the caller.
 */
export function d1Endpoint({
  database = "CODY_DB",
  local = false,
  confirm = async () => true,
  run = runWrangler,
  attempts = 4,
  retryDelayMs = 1000,
} = {}) {
  const location = local ? "--local" : "--remote";
  const statements = [];
  return {
    limits: D1_LIMITS,
    async read(queries) {
      if (queries.length === 0) return [];
      const command = queries
        .map(({ sql, values }) => inlineSql(sql, values))
        .join(";\n");
      const args = [
        "d1",
        "execute",
        database,
        location,
        "--json",
        "--command",
        command,
      ];
      let output;
      for (let attempt = 1; ; attempt += 1) {
        try {
          output = await run(args, { capture: true });
          break;
        } catch (error) {
          if (attempt >= attempts) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * attempt),
          );
        }
      }
      const results = JSON.parse(output);
      if (
        !Array.isArray(results) ||
        results.length !== queries.length ||
        results.some((result) => !result.success)
      )
        throw new Error(
          `Unexpected wrangler d1 execute output: ${output.slice(0, 500)}`,
        );
      return results.map((result) => result.results ?? []);
    },
    async write(commands) {
      for (const { sql, values } of commands)
        statements.push(inlineSql(sql, values));
      return null;
    },
    async commit() {
      if (statements.length === 0) return;
      const script = `${statements.join(";\n")};\n`;
      if (
        !(await confirm({
          statements: statements.length,
          bytes: Buffer.byteLength(script),
        }))
      )
        throw new Error("D1 import cancelled; nothing was written");
      const directory = await mkdtemp(path.join(tmpdir(), "cody-d1-"));
      try {
        const file = path.join(directory, "reporting.sql");
        await writeFile(file, script, { mode: 0o600 });
        // The caller has confirmed; a declined Wrangler prompt would exit 0.
        await run(
          ["d1", "execute", database, location, "--file", file, "--yes"],
          { capture: false },
        );
        statements.length = 0;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
