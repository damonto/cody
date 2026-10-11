import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCloudflareConnection,
  readWranglerConfig,
  wranglerJson,
} from "../scripts/transfer-wrangler.mjs";
import { CloudflareTransfer } from "../scripts/transfer-cloudflare.mjs";
import { main } from "../scripts/transfer-data.mjs";

const account = "a".repeat(32);

test("Cloudflare reuses Wrangler OAuth login and discovers a single account", async () => {
  const calls = [];
  const source = { HOME: "/mock-home" };
  const connection = await resolveCloudflareConnection(
    "SOURCE",
    source,
    {},
    {
      readConfig: async (args) => {
        assert.deepEqual(args, {});
        return { name: "cody" };
      },
      run: async (args, env) => {
        calls.push(args);
        assert.equal(env.HOME, source.HOME);
        if (args[0] === "auth")
          return { type: "oauth", token: "mock-login-token" };
        return { loggedIn: true, accounts: [{ id: account }] };
      },
    },
  );
  assert.equal(connection.worker, "cody");
  assert.equal(connection.account, account);
  assert.deepEqual(await connection.authorizationHeaders(), {
    authorization: "Bearer mock-login-token",
  });
  assert.deepEqual(calls, [["auth", "token"], ["whoami"]]);
  assert.equal(connection.env.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(connection.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.deepEqual(source, { HOME: "/mock-home" });
});

test("Wrangler resolves named environments from JSONC and TOML without manual suffixes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-wrangler-config-"));
  try {
    const json = join(directory, "wrangler.jsonc"),
      toml = join(directory, "wrangler.toml");
    await writeFile(
      json,
      `{
      // This file uses Wrangler's configuration parser.
      "name": "cody", "account_id": "${account}",
      "env": {"production": {"name": "cody-live"}, "staging": {}},
    }`,
    );
    await writeFile(
      toml,
      `name = "cody-toml"\naccount_id = "${account}"\n[env.staging]\n`,
    );
    assert.equal(
      (await readWranglerConfig({ config: json, env: "production" })).name,
      "cody-live",
    );
    assert.equal(
      (await readWranglerConfig({ config: json, env: "staging" })).name,
      "cody-staging",
    );
    assert.equal(
      (await readWranglerConfig({ config: toml, env: "staging" })).name,
      "cody-toml-staging",
    );
    const auth = await wranglerJson(["auth", "token", "--config", json], {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "mock-api-token-no-network",
      CLOUDFLARE_API_KEY: "",
      CLOUDFLARE_EMAIL: "",
    });
    assert.deepEqual(auth, {
      type: "api_token",
      token: "mock-api-token-no-network",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("per-side overrides isolate credentials while config selectors reach Wrangler", async () => {
  const environment = {
    CLOUDFLARE_API_TOKEN: "global-token",
    CLOUDFLARE_API_KEY: "global-key",
    CLOUDFLARE_EMAIL: "global@example.com",
    SOURCE_CLOUDFLARE_API_TOKEN: "source-token",
    SOURCE_CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    SOURCE_CLOUDFLARE_WORKER: "different-worker",
  };
  const calls = [];
  const connection = await resolveCloudflareConnection(
    "SOURCE",
    environment,
    { config: "other.jsonc", env: "production" },
    {
      readConfig: async (args) => {
        assert.deepEqual(args, { config: "other.jsonc", env: "production" });
        return { name: "cody-production", account_id: account };
      },
      run: async (args, env) => {
        calls.push(args);
        assert.equal(env.CLOUDFLARE_API_TOKEN, "source-token");
        assert.equal(env.CLOUDFLARE_API_KEY, undefined);
        assert.equal(env.CLOUDFLARE_EMAIL, undefined);
        return { type: "api_token", token: env.CLOUDFLARE_API_TOKEN };
      },
    },
  );
  assert.equal(connection.account, "b".repeat(32));
  assert.equal(connection.worker, "different-worker");
  assert.deepEqual(calls, [
    ["auth", "token", "--config", "other.jsonc", "--env", "production"],
  ]);
  assert.equal(environment.CLOUDFLARE_API_KEY, "global-key");
});

test("multiple accounts require explicit selection and configured accounts bypass discovery", async () => {
  const dependencies = {
    readConfig: async () => ({ name: "cody" }),
    run: async (args) =>
      args[0] === "auth"
        ? { type: "api_token", token: "mock-token" }
        : {
            loggedIn: true,
            accounts: [{ id: account }, { id: "b".repeat(32) }],
          },
  };
  await assert.rejects(
    resolveCloudflareConnection("TARGET", {}, {}, dependencies),
    /found 2 accounts.*TARGET_CLOUDFLARE_ACCOUNT_ID/,
  );
  const connection = await resolveCloudflareConnection(
    "TARGET",
    {},
    {},
    {
      ...dependencies,
      readConfig: async () => ({ name: "cody", account_id: account }),
      run: async (args) => {
        assert.equal(args[0], "auth");
        return { type: "api_key", key: "mock-key", email: "mock@example.com" };
      },
    },
  );
  assert.deepEqual(await connection.authorizationHeaders(), {
    "x-auth-key": "mock-key",
    "x-auth-email": "mock@example.com",
  });
  assert.equal(connection.env.CLOUDFLARE_API_KEY, "mock-key");
  assert.equal(connection.env.CLOUDFLARE_EMAIL, "mock@example.com");
});

test("an expired OAuth credential refreshes through Wrangler once; operation failures are not retried", async () => {
  let authorizations = 0;
  const connection = await resolveCloudflareConnection(
    "SOURCE",
    {},
    {},
    {
      readConfig: async () => ({ name: "cody", account_id: account }),
      run: async () => ({ type: "oauth", token: `mock-${++authorizations}` }),
    },
  );
  let attempts = 0,
    status = 401;
  const cf = new CloudflareTransfer(connection, async (_url, options) => {
    attempts++;
    assert.equal(
      options.headers.authorization,
      `Bearer mock-${authorizations}`,
    );
    return attempts === 1 || status !== 401
      ? new Response(null, { status })
      : Response.json({ success: true, result: [] });
  });
  assert.deepEqual(await cf.api("/queues"), { success: true, result: [] });
  assert.equal(authorizations, 2);
  assert.equal(attempts, 2);
  status = 503;
  await assert.rejects(cf.api("/queues/messages/ack", { acks: [] }), /503/);
  assert.equal(attempts, 3);
  assert.equal(authorizations, 2);
});

test("Wrangler authentication failures do not expose captured credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cody-wrangler-invalid-"));
  try {
    const config = join(directory, "invalid.jsonc");
    await writeFile(config, "mock-secret-invalid-config");
    await assert.rejects(
      wranglerJson(["auth", "token", "--config", config], {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "mock-secret-token",
      }),
      (error) => {
        assert.match(
          error.message,
          /Wrangler authentication or account discovery failed/,
        );
        assert.ok(!JSON.stringify(error).includes("mock-secret"));
        assert.equal(error.stdout, undefined);
        assert.equal(error.stderr, undefined);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects Wrangler selectors on SQL endpoints before opening connections", async () => {
  await assert.rejects(
    main(
      ["--from", "sqlite", "--to", "postgres", "--from-env", "production"],
      {},
    ),
    /apply only to Cloudflare/,
  );
});
