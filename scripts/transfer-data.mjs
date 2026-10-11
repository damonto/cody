import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  TRANSFER_VERSION,
  TransferError,
  transferFailure,
} from "../src/transfer/protocol.ts";
import {
  newState,
  transferInstances,
  abortTransfer,
} from "../src/transfer/runner.ts";
import { openEndpoint } from "./transfer-endpoint.mjs";
import { openState } from "./transfer-state.mjs";

const HELP = `Usage: npm run data:transfer -- --from <platform> --to <platform> [options]
Platforms: cloudflare, sqlite, postgres, libsql. Fresh targets only.
Copies business database tables and OAuth accounts only. D1 uses Wrangler file
export/import and requires sqlite3. Health, caches and unrecorded usage are excluded.

  --dry-run       Read-only schema/key/access/empty-target checks
  --yes           Confirm both deployments are idle without prompting
  --resume <id>   Resume using the local state file
  --abort <id>    Restore source scheduling before target activation
  --state-dir    Local progress directory (default: .cody-transfer)
  --from-config  Source Wrangler config (default: auto-discovered)
  --to-config    Target Wrangler config (default: auto-discovered)
  --from-env     Source Wrangler environment
  --to-env       Target Wrangler environment

Set SOURCE_/TARGET_DATABASE_URL and SOURCE_/TARGET_CONFIG_ENCRYPTION_KEY
(or shared CONFIG_ENCRYPTION_KEY). Cloudflare uses Wrangler login and project
configuration by default. SOURCE_/TARGET_CLOUDFLARE_API_TOKEN,
CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKER are optional per-side overrides.
Credentials are accepted through environment variables only.

Stop requests, background/cron jobs and wait for in-flight work on BOTH instances.
This is an operator precondition: the CLI does not enforce a runtime maintenance
lock. Standard servers should remain stopped; Cloudflare OAuth alarms are paused
by the CLI and restored on the target after verification. Keep the source stopped
after success and switch traffic separately. Preserve the local state file.
Retired task files are unsupported; start a new task with a fresh target.`;

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "from-config": { type: "string" },
      "to-config": { type: "string" },
      "from-env": { type: "string" },
      "to-env": { type: "string" },
      resume: { type: "string" },
      abort: { type: "string" },
      "state-dir": { type: "string", default: ".cody-transfer" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.from || !values.to) throw new TransferError(HELP);
  if (
    [values.resume, values.abort, values["dry-run"]].filter(Boolean).length > 1
  )
    throw new TransferError("Choose one of --resume, --abort or --dry-run");
  for (const side of ["from", "to"])
    if (
      values[side] !== "cloudflare" &&
      (values[`${side}-config`] || values[`${side}-env`])
    )
      throw new TransferError(
        `--${side}-config and --${side}-env apply only to Cloudflare`,
      );
  let source, target, journal;
  let step = "Source connection";
  try {
    source = await openEndpoint(values.from, "SOURCE", env, {
      config: values["from-config"],
      env: values["from-env"],
    });
    step = "Target connection";
    target = await openEndpoint(values.to, "TARGET", env, {
      fresh: !values.resume && !values.abort,
      config: values["to-config"],
      env: values["to-env"],
    });
    const challenge = crypto.randomUUID();
    step = "Source";
    const sourceInfo = await source.call({ action: "preflight", challenge });
    step = "Target";
    const targetInfo = await target.call({ action: "preflight", challenge });
    step = "Instance compatibility";
    if (
      sourceInfo.version !== TRANSFER_VERSION ||
      targetInfo.version !== TRANSFER_VERSION ||
      sourceInfo.schema !== targetInfo.schema
    )
      throw new TransferError("Code/schema differs between instances");
    if (sourceInfo.key_proof !== targetInfo.key_proof)
      throw new TransferError("CONFIG_ENCRYPTION_KEY differs");
    if (source.identity === target.identity)
      throw new TransferError("Source and target are the same database");
    if (
      !values.resume &&
      !values.abort &&
      (!targetInfo.empty || sourceInfo.fingerprint === targetInfo.fingerprint)
    )
      throw new TransferError("Target must be a different, fresh instance");
    if (values["dry-run"]) {
      console.log(
        "Preflight passed; no data, alarms or local task file changed.",
      );
      return;
    }
    step = "Maintenance confirmation";
    if (!values.yes) {
      if (!process.stdin.isTTY)
        throw new TransferError(
          "Stop both deployments and pass --yes to confirm",
        );
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await prompt.question(
          "Stop requests and background/cron jobs on BOTH instances; wait for in-flight work. Keep the source stopped after success. Confirm both are idle? [y/N] ",
        );
        if (!/^y(?:es)?$/i.test(answer.trim()))
          throw new TransferError("Cancelled; nothing was written");
      } finally {
        prompt.close();
      }
    }
    step = "Local task state";
    const id = values.resume ?? values.abort ?? crypto.randomUUID();
    journal = await openState(
      values["state-dir"],
      id,
      values.resume || values.abort
        ? undefined
        : newState(id, source.identity, target.identity, sourceInfo.schema),
    );
    if (
      journal.state.source !== source.identity ||
      journal.state.target !== target.identity ||
      journal.state.schema !== sourceInfo.schema
    )
      throw new TransferError(
        "Local state belongs to different endpoints or schema",
      );
    await journal.save();
    console.error(
      `Task ${id}; keep ${journal.filename} for --resume or --abort.`,
    );
    step = values.abort ? "Transfer abort" : "Transfer";
    if (values.abort) {
      await abortTransfer(source, target, journal);
      console.log(
        "Source scheduling restored. Discard the incomplete target before another transfer.",
      );
      return;
    }
    await transferInstances(source, target, journal, (message) =>
      console.error(message),
    );
    console.log(
      `Transfer ${id} verified. Start the target and switch traffic; keep the source stopped.`,
    );
  } catch (error) {
    const id = journal?.state.id ?? values.resume ?? values.abort;
    const message = transferFailure(error, step).message;
    const recovery = !id
      ? "No transfer data was written. Fix the issue and rerun the command."
      : journal?.state.phase === "aborted"
        ? `Task ${id} was aborted. Discard its incomplete target.`
        : journal?.state.phase === "activating" ||
            journal?.state.phase === "completed"
          ? `Keep the old source stopped. Target scheduling has begun; use --resume ${id} if activation is incomplete.`
          : journal?.state.phase === "aborting" || values.abort
            ? `Keep both deployments stopped. Preserve the state file and finish --abort ${id}.`
            : `Keep both deployments stopped. Preserve the state file and use --resume ${id}; do not serve a partial target.`;
    throw new TransferError(`${message}\n${recovery}`);
  } finally {
    try {
      await journal?.close();
    } finally {
      await Promise.allSettled([source?.close(), target?.close()]);
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof TransferError
        ? error.message
        : "Transfer failed validation, persistence or endpoint access.",
    );
    process.exitCode = 1;
  });
}
