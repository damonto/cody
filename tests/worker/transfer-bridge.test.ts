import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { keyProof, TRANSFER_VERSION } from "../../src/transfer/protocol.ts";
import { ProviderHealth } from "../../src/platform/cloudflare/objects.ts";
import bridge from "../../scripts/transfer-bridge.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const bridgeEnv = {
  ...env,
  BRIDGE_TOKEN: "test-private-token",
};
beforeAll(() => applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

function bridgePreflight(bindings = bridgeEnv) {
  return bridge.fetch(
    new Request("https://transfer/", {
      method: "POST",
      headers: { authorization: `Bearer ${bindings.BRIDGE_TOKEN}` },
      body: JSON.stringify({
        action: "preflight",
        challenge: crypto.randomUUID(),
      }),
    }),
    bindings,
  );
}

test("bridge preflight validates the deployed RPC without writing SQL or object storage", async () => {
  const before = await env.CODY_DB.prepare("SELECT * FROM config_meta").all();
  const response = await bridgePreflight();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    version: TRANSFER_VERSION,
    platform: "cloudflare",
    empty: true,
  });
  expect(
    await env.CODY_DB.prepare("SELECT * FROM config_meta").all(),
  ).toMatchObject({ results: before.results });
  await runInDurableObject(
    env.HEALTH.getByName("_transfer:probe"),
    async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    },
  );
});

test("an unavailable deployed transfer RPC fails before SQL and gives deployment guidance", async () => {
  vi.spyOn(ProviderHealth.prototype, "transferProbe").mockRejectedValueOnce(
    new TypeError(
      "The RPC receiver does not implement transferProbe; private-rpc-detail",
    ),
  );
  const queries = vi.spyOn(env.CODY_DB, "prepare");
  const response = await bridgePreflight();
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain("deployed Worker transferProbe RPC");
  expect(body).toContain(
    "deploy the selected Worker from the same Cody release",
  );
  expect(body).not.toContain("private-rpc-detail");
  expect(queries).not.toHaveBeenCalled();
});

test("preflight distinguishes a deployed protocol mismatch from database failures", async () => {
  vi.spyOn(ProviderHealth.prototype, "transferProbe").mockResolvedValueOnce({
    version: TRANSFER_VERSION + 1,
    proof: "a".repeat(64),
  });
  const queries = vi.spyOn(env.CODY_DB, "prepare");
  const response = await bridgePreflight();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain(
    "Deployed Worker transfer protocol differs",
  );
  expect(queries).not.toHaveBeenCalled();
});

test("D1 failures identify the preflight check without exposing query details", async () => {
  vi.spyOn(env.CODY_DB, "prepare").mockImplementationOnce(() => {
    throw new Error("D1_ERROR: no such column: private-query-data");
  });
  const response = await bridgePreflight();
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain("preflight: database schema");
  expect(body).toContain("apply this release's migrations");
  expect(body).not.toContain("private-query-data");
  expect(body).not.toContain("transferProbe RPC");
});

test("preflight ignores queue metrics even when queue access is unavailable", async () => {
  const metrics = vi
    .spyOn(env.USAGE_QUEUE, "metrics")
    .mockRejectedValue(new Error("private-queue-error"));
  const response = await bridgePreflight();
  expect(response.status).toBe(200);
  expect(metrics).not.toHaveBeenCalled();
});

for (const action of ["read", "write"] as const) {
  test(`bridge refuses table ${action} RPC before accessing D1`, async () => {
    const queries = vi.spyOn(env.CODY_DB, "prepare");
    const response = await bridge.fetch(
      new Request("https://transfer/", {
        method: "POST",
        headers: { authorization: `Bearer ${bridgeEnv.BRIDGE_TOKEN}` },
        body: JSON.stringify({
          action,
          table: "providers",
          cursor: null,
          ...(action === "write"
            ? { rows: [], next_cursor: null, digest: "a".repeat(64) }
            : {}),
        }),
      }),
      bridgeEnv,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Wrangler file export/import");
    expect(queries).not.toHaveBeenCalled();
  });
}

test("bridge rejects a deployed encryption key mismatch", async () => {
  vi.spyOn(ProviderHealth.prototype, "transferProbe").mockImplementationOnce(
    async (challenge) => ({
      version: TRANSFER_VERSION,
      proof: await keyProof(btoa("different-key".padEnd(32, "!")), challenge),
    }),
  );
  const response = await bridgePreflight();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain(
    "Deployed Worker encryption key differs",
  );
});
