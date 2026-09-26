import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { connectDatabase } from "../src/platform/standard/sql/connect.ts";
import {
  sqlTransferEndpoint,
  transferReporting,
} from "../src/reporting/transfer.ts";
import { d1Endpoint } from "./d1-wrangler.mjs";

const USAGE = `Usage: npm run reporting:transfer -- [--from <endpoint>] [--to <endpoint>] [options]

Copies finished requests, their attempts and hourly usage rollups. An endpoint
is d1 (the CODY_DB binding through Wrangler), d1:<database>, or a sqlite:,
libsql:// or postgres:// URL. An omitted endpoint defaults to DATABASE_URL.

Options:
  --since <time>  Copy requests started at or after this ISO 8601 time or
                  epoch millisecond, rounded down to the hour
  --local         Use Wrangler's local D1 database instead of the remote one
  --dry-run       Read and count without writing
  --yes           Import into D1 without asking for confirmation`;

const isD1 = (endpoint) => endpoint === "d1" || endpoint.startsWith("d1:");

/** Names an endpoint without its credentials. */
function describe(endpoint, local) {
  if (isD1(endpoint))
    return `D1 ${endpoint.slice(3) || "CODY_DB"} (${local ? "local" : "remote"})`;
  if (endpoint.startsWith("sqlite:")) return endpoint;
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function parseSince(value) {
  if (value === undefined) return 0;
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0)
    throw new Error(`Invalid --since time: ${value}`);
  return time;
}

async function open(endpoint, options) {
  if (isD1(endpoint))
    return {
      endpoint: d1Endpoint({
        database: endpoint.slice(3) || "CODY_DB",
        local: options.local,
        confirm: options.confirm,
      }),
      close: async () => {},
    };
  const db = await connectDatabase(endpoint, { max: 1 });
  return { endpoint: sqlTransferEndpoint(db), close: async () => db.close() };
}

async function preflight(endpoint, name) {
  try {
    await endpoint.read(
      ["requests", "request_attempts", "usage_hourly"].map((table) => ({
        sql: `SELECT * FROM ${table} WHERE 1 = 0`,
        values: [],
      })),
    );
  } catch (error) {
    throw new Error(
      `Cannot read the reporting tables of ${name}; apply its migrations first.\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      since: { type: "string" },
      local: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
  } else {
    const from = values.from ?? process.env.DATABASE_URL;
    const to = values.to ?? process.env.DATABASE_URL;
    if (!from || !to) throw new Error(USAGE);
    if (from === to)
      throw new Error("The source and target endpoints must differ");
    const since = parseSince(values.since);
    const dryRun = values["dry-run"];
    if (isD1(to) && !dryRun && !values.yes && !process.stdin.isTTY)
      throw new Error("Pass --yes to import into D1 without a prompt");
    const target = describe(to, values.local);
    const confirm = async ({ statements, bytes }) => {
      if (values.yes) return true;
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await prompt.question(
          `Import ${statements} statements (${(bytes / 1e6).toFixed(1)} MB) into ${target}? D1 pauses other queries during the import. [y/N] `,
        );
        return /^y(?:es)?$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    };
    const source = await open(from, { local: values.local });
    try {
      const destination = await open(to, { local: values.local, confirm });
      try {
        await preflight(source.endpoint, describe(from, values.local));
        await preflight(destination.endpoint, target);
        console.error(
          `${dryRun ? "Counting" : "Copying"} request history from ${describe(from, values.local)} to ${target}`,
        );
        const result = await transferReporting(
          source.endpoint,
          destination.endpoint,
          {
            since,
            dryRun,
            onProgress: (requests) =>
              console.error(`  ${requests} requests read`),
          },
        );
        const inserted = (count) => (count === null ? "" : `, ${count} new`);
        console.log(
          `Requests: ${result.requests}${inserted(result.insertedRequests)}`,
        );
        console.log(
          `Attempts: ${result.attempts}${inserted(result.insertedAttempts)}`,
        );
        if (result.adjustments > 0)
          console.log(
            `Rollups without retained requests: ${result.adjustments}`,
          );
        if (result.pending > 0)
          console.log(
            `In-flight requests left for a later run: ${result.pending}`,
          );
        if (dryRun) console.log("Dry run: nothing was written.");
      } finally {
        await destination.close();
      }
    } finally {
      await source.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
