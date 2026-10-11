import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { TransferService } from "../../src/transfer/service.ts";
import { cloudflareTransferObjects } from "../../src/transfer/cloudflare.ts";
import { hash } from "../../src/transfer/protocol.ts";
import {
  readObjectStorage,
  writeObjectStorage,
} from "../../src/transfer/objects.ts";
import {
  AlarmState,
  BackedObjectStorage,
  MemoryObjectBackend,
} from "../../src/platform/standard/objects.ts";
import { decryptConfig } from "../../src/control/crypto.ts";
import { seedTransferAccounts } from "../helpers/transfer-fixture.ts";
import bridge from "../../scripts/transfer-bridge.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const bridgeEnv = {
  ...env,
  BRIDGE_TOKEN: "test-private-token",
};
const objects = cloudflareTransferObjects(bridgeEnv);
const service = new TransferService(env, objects, "cloudflare");
const backend = new MemoryObjectBackend();
const storage = (name: string) =>
  new BackedObjectStorage(
    backend,
    "test",
    name,
    new AlarmState(backend, "test", name),
  );

beforeAll(() => applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

test("four OAuth providers roundtrip between SQL-style storage and Durable Objects", async () => {
  const fixtures = await seedTransferAccounts(
    env.CODY_DB,
    env.CONFIG_ENCRYPTION_KEY,
    async (ref, entries) => {
      if (ref.kind !== "oauth") return;
      const snapshot = { ref, entries, alarm: null };
      const local = storage(`${ref.kind}:${ref.name}`);
      await writeObjectStorage(local, snapshot, await hash(snapshot));
      const exported = await readObjectStorage(local, ref);
      await objects.write(exported, await hash(exported));
      await objects.write(exported, await hash(exported));
    },
  );
  for (const fixture of fixtures) {
    const { snapshot } = await service.execute({
      action: "read_object",
      ref: fixture.object,
    });
    expect(snapshot.alarm).toBeNull();
    expect(snapshot.entries).toEqual([["account", fixture.ciphertext]]);
    expect(
      await decryptConfig(
        snapshot.entries[0][1] as string,
        env.CONFIG_ENCRYPTION_KEY,
      ),
    ).toEqual(fixture.account);
    const restored = storage(`restored:${fixture.object.name}`);
    await writeObjectStorage(restored, snapshot, await hash(snapshot));
    expect(await restored.get("account")).toBe(fixture.ciphertext);
    const alarm = Date.now() + 3600000;
    await objects.schedule(fixture.object, alarm);
    expect((await objects.read(fixture.object)).alarm).toBe(alarm);
    await objects.schedule(fixture.object, null);
  }
});

test("temporary bridge rejects unauthenticated calls and arbitrary SQL", async () => {
  expect(
    (
      await bridge.fetch(
        new Request("https://transfer/", { method: "POST" }),
        bridgeEnv,
      )
    ).status,
  ).toBe(404);
  const response = await bridge.fetch(
    new Request("https://transfer/", {
      method: "POST",
      headers: { authorization: `Bearer ${bridgeEnv.BRIDGE_TOKEN}` },
      body: JSON.stringify({ action: "sql", sql: "DELETE FROM providers" }),
    }),
    bridgeEnv,
  );
  expect(response.ok).toBe(false);
});
