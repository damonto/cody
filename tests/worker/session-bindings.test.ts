import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  affinityRegistryName,
  type SessionAffinityRecord,
} from "../../src/gateway/routing/affinity.ts";
import { RequestLogContext } from "../../src/shared/log.ts";
import {
  handleSessionClearAll,
  handleSessionList,
} from "../../src/gateway/sessions/session-bindings.ts";
import type { ClientApiKeyConfig } from "../../src/config/types.ts";

function client(): ClientApiKeyConfig {
  return {
    id: crypto.randomUUID(),
    api_key: crypto.randomUUID(),
    providers: [],
  };
}

async function seed(
  client: ClientApiKeyConfig,
  digestPrefix: string,
  active = true,
) {
  const registry = await affinityRegistryName(client.id);
  const record: SessionAffinityRecord = {
    provider_id: "provider",
    credential_id: "key",
    registry_name: registry,
    session_digest: digestPrefix.repeat(64),
    session_id: `session-${digestPrefix}`,
    binding_id: crypto.randomUUID(),
    generation: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    index_registered: true,
  };
  const index = env.SESSION_AFFINITY_INDEX.getByName(registry);
  await index.register(record);
  const stub = env.SESSION_AFFINITY.getByName(
    `${registry}:${record.session_digest}`,
  );
  if (active) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("affinity", record);
    });
  }
  return { record, index, stub };
}

async function list(
  client: ClientApiKeyConfig,
  limit: number,
  cursor: string | null = null,
) {
  const url = new URL("https://gateway.example/sessions");
  url.searchParams.set("limit", String(limit));
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  const request = new Request(url);
  const response = await handleSessionList(
    env,
    client,
    url,
    new RequestLogContext("test", request),
  );
  expect(response.status).toBe(200);
  return response.json<{
    data: { session_id: string; provider_id: string }[];
    next_cursor: string | null;
  }>();
}

test("stale pages advance without skipping or duplicating active sessions", async () => {
  const owner = client();
  const stale = await seed(owner, "1", false);
  await seed(owner, "2");
  await seed(owner, "3");
  await seed(owner, "4");
  await seed(owner, "5");

  const first = await list(owner, 1);
  expect(first.data).toEqual([]);
  expect(first.next_cursor).not.toBeNull();
  expect(await stale.index.get(stale.record.session_digest)).toBeNull();
  const seen: string[] = [];
  let cursor = first.next_cursor;
  for (let pageNumber = 0; cursor !== null && pageNumber < 10; pageNumber++) {
    const page = await list(owner, pageNumber === 0 ? 2 : 1, cursor);
    seen.push(...page.data.map(({ session_id }) => session_id));
    cursor = page.next_cursor;
  }
  expect(cursor).toBeNull();
  expect(seen).toEqual(["session-2", "session-3", "session-4", "session-5"]);
});

test("credential rotation preserves the client's session registry", async () => {
  const owner = client();
  await seed(owner, "1");
  owner.api_key = crypto.randomUUID();
  expect(await list(owner, 1)).toMatchObject({
    data: [{ session_id: "session-1", provider_id: "provider" }],
    next_cursor: null,
  });
});

test("bulk clearing removes active and stale entries while leaving other clients intact", async () => {
  const owner = client();
  const first = await seed(owner, "1");
  const second = await seed(owner, "2");
  await seed(owner, "3", false);
  const other = await seed(client(), "1");
  const request = new Request("https://gateway.example/sessions", {
    method: "DELETE",
  });
  const response = await handleSessionClearAll(
    env,
    owner,
    new RequestLogContext("clear", request),
  );
  expect(await response.json()).toEqual({ deleted: 2 });
  for (const { stub } of [first, second]) {
    expect(await stub.getStatus()).toBeNull();
  }
  expect(await other.stub.getStatus()).not.toBeNull();
  expect(await list(owner, 1)).toMatchObject({ data: [], next_cursor: null });
});

test("session listing rejects malformed cursors", async () => {
  const url = new URL("https://gateway.example/sessions");
  url.searchParams.set("cursor", btoa("malformed"));
  const request = new Request(url);
  const response = await handleSessionList(
    env,
    client(),
    url,
    new RequestLogContext("list", request),
  );
  expect(response.status).toBe(400);
});
