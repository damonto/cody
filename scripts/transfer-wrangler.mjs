import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TransferError } from "../src/transfer/protocol.ts";

const execute = promisify(execFile);
const wrangler = fileURLToPath(
  new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json")),
);
const accountId = z.string().regex(/^[a-f0-9]{32}$/);

/** Native D1 file transfer; suppress SQL, credentials and Wrangler disk logs. */
export async function runWrangler(args, env) {
  try {
    await execute(process.execPath, [wrangler, ...args], {
      env: {
        ...env,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG: "none",
      },
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new TransferError(
      `Wrangler D1 ${args[1] === "export" ? "export" : "import"} failed; check authentication, database permissions and D1 import limits`,
    );
  }
}
const credentialsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["api_token", "oauth"]), token: z.string().min(1) }),
  z.object({
    type: z.literal("api_key"),
    key: z.string().min(1),
    email: z.string().min(1),
  }),
]);

/** Capture credentials in memory. Never echo Wrangler output or child-process errors. */
export async function wranglerJson(args, env) {
  try {
    const { stdout } = await execute(
      process.execPath,
      [wrangler, ...args, "--json"],
      {
        env: {
          ...env,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_LOG: "log",
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(stdout);
  } catch {
    throw new TransferError(
      "Wrangler authentication or account discovery failed; run npx wrangler login and check the selected configuration",
    );
  }
}

export async function readWranglerConfig(args) {
  try {
    const { unstable_readConfig } = await import("wrangler");
    return unstable_readConfig(args, { hideWarnings: true });
  } catch {
    throw new TransferError(
      "Cannot read Wrangler configuration; check the selected config file and environment",
    );
  }
}

/** Resolve deployment metadata with Wrangler's own config and authentication rules. */
export async function resolveCloudflareConnection(
  prefix,
  source = process.env,
  options = {},
  { readConfig = readWranglerConfig, run = wranglerJson } = {},
) {
  const env = { ...source };
  if (source[`${prefix}_CLOUDFLARE_API_TOKEN`]) {
    // Per-side credentials must not inherit a different global account's API key.
    for (const key of [
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CF_API_KEY",
      "CF_EMAIL",
      "CF_API_TOKEN",
    ])
      delete env[key];
    env.CLOUDFLARE_API_TOKEN = source[`${prefix}_CLOUDFLARE_API_TOKEN`];
  }
  const args = {
    ...(options.config ? { config: options.config } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const flags = Object.entries(args).flatMap(([name, value]) => [
    `--${name}`,
    value,
  ]);
  const config = await readConfig(args);
  const worker = source[`${prefix}_CLOUDFLARE_WORKER`] ?? config.name;
  if (typeof worker !== "string" || !worker)
    throw new TransferError(
      "Set the deployed Worker name in the selected Wrangler configuration",
    );

  let cached;
  const authorizationHeaders = async (refresh = false) => {
    if (refresh) cached = undefined;
    cached ??= run(["auth", "token", ...flags], env).then((value) => {
      const parsed = credentialsSchema.safeParse(value);
      if (!parsed.success)
        throw new TransferError(
          "Wrangler returned invalid authentication credentials",
        );
      return parsed.data;
    });
    const credentials = await cached;
    // Wrangler may load API credentials from the selected environment's .env
    // file. The preview must use those same credentials. Keep OAuth as a login
    // session so Wrangler can refresh it instead of treating it as a fixed token.
    if (credentials.type === "api_token") {
      env.CLOUDFLARE_API_TOKEN = credentials.token;
      delete env.CLOUDFLARE_API_KEY;
      delete env.CLOUDFLARE_EMAIL;
      delete env.CF_API_KEY;
      delete env.CF_EMAIL;
    } else if (credentials.type === "api_key") {
      env.CLOUDFLARE_API_KEY = credentials.key;
      env.CLOUDFLARE_EMAIL = credentials.email;
      delete env.CLOUDFLARE_API_TOKEN;
      delete env.CF_API_TOKEN;
    }
    return credentials.type === "api_key"
      ? { "x-auth-key": credentials.key, "x-auth-email": credentials.email }
      : { authorization: `Bearer ${credentials.token}` };
  };
  await authorizationHeaders();
  let account =
    source[`${prefix}_CLOUDFLARE_ACCOUNT_ID`] ??
    source.CLOUDFLARE_ACCOUNT_ID ??
    config.account_id;
  if (!account) {
    const result = z
      .object({
        loggedIn: z.literal(true),
        accounts: z.array(z.object({ id: accountId })),
      })
      .safeParse(await run(["whoami", ...flags], env));
    if (!result.success)
      throw new TransferError("Wrangler returned invalid account information");
    if (result.data.accounts.length !== 1)
      throw new TransferError(
        `Wrangler found ${result.data.accounts.length} accounts; set account_id in the selected config or ${prefix}_CLOUDFLARE_ACCOUNT_ID`,
      );
    account = result.data.accounts[0].id;
  }
  if (!accountId.safeParse(account).success)
    throw new TransferError("Invalid Cloudflare account ID");
  env.CLOUDFLARE_ACCOUNT_ID = account;
  return { account, worker, env, authorizationHeaders };
}
