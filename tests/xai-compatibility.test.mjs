import assert from "node:assert/strict";
import test from "node:test";
import { convertResponse } from "../src/providers/xai/response.ts";
import { translateRequest } from "../src/providers/xai/request.ts";
import { xaiBadCredentials } from "../src/providers/xai/errors.ts";
import { xaiLimit } from "../src/providers/xai/limits.ts";
import { XaiClient } from "../src/providers/xai/api.ts";
import { openReasoning, sealReasoning } from "../src/providers/xai/replay.ts";
import {
  historySession,
  mergeHistory,
  prepareHistory,
} from "../src/providers/xai/history.ts";
import { XaiReplayStore } from "../src/providers/xai/replay-store.ts";
import {
  AlarmState,
  BackedObjectStorage,
  MemoryObjectBackend,
} from "../src/platform/standard/objects.ts";
import { accountViewSchema } from "../src/providers/oauth/schema.ts";

// Fixtures cover CLIProxyAPI 673131f5 xai_executor_response/request and xai_status_err tests.
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const scope = {
  provider_id: "xai",
  model: "grok-4.7",
  client_id: "client",
  account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const message = (id, value) => ({
  type: "message",
  id,
  role: "assistant",
  content: [{ type: "output_text", text: value }],
});
const terminal = {
  type: "response.completed",
  response: { id: "resp", status: "completed" },
};
const sse = (events) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const options = (extra = {}) => ({
  scope,
  key,
  model: scope.model,
  anthropic: false,
  stream: false,
  tools: [],
  ...extra,
});
const translate = (body, anthropic = false, extra) =>
  translateRequest(body, anthropic, scope, key, [scope.account_ref], extra);

test("reference defaults preserve instructions and top_k without injecting an identity", async () => {
  assert.equal((await translate({ input: "hello", top_k: 7 })).body.top_k, 7);
  assert.equal((await translate({ input: "hello" })).body.instructions, "");
  assert.equal(
    (await translate({ input: "hello", instructions: "Keep mine" })).body
      .instructions,
    "Keep mine",
  );
  await assert.rejects(translate({ input: "hello", top_k: "bad" }));
});

test("reference indexless output items and terminal enrichment do not overwrite each other", async () => {
  const a = message("one", "One"),
    b = message("two", "Two");
  const response = await convertResponse(
    sse([
      { type: "response.output_item.done", item: a },
      { type: "response.output_item.done", item: b },
      terminal,
    ]),
    options(),
  );
  assert.deepEqual(
    (await response.json()).output.map((item) => item.id),
    ["one", "two"],
  );
  const enriched = await convertResponse(
    sse([
      { type: "response.output_item.done", output_index: 7, item: a },
      { ...terminal, response: { output: [a, b] } },
    ]),
    options(),
  );
  assert.deepEqual(
    (await enriched.json()).output.map((item) => item.id),
    ["one", "two"],
  );
});

test("Grok reasoning content and done-only text retain a sealed native replay", async () => {
  const native = {
    type: "reasoning",
    id: "r",
    summary: [],
    content: [{ type: "reasoning_text", text: "Reason" }],
    encrypted_content: "native",
  };
  const response = await convertResponse(
    sse([{ type: "response.output_item.done", item: native }, terminal]),
    options(),
  );
  const item = (await response.json()).output[0];
  assert.equal(item.content, undefined);
  assert.deepEqual(item.summary, [{ type: "summary_text", text: "Reason" }]);
  assert.deepEqual(
    await openReasoning(item.encrypted_content, "Reason", scope, key, [
      scope.account_ref,
    ]),
    native,
  );
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "r" },
    },
    {
      type: "response.reasoning_text.done",
      item_id: "r",
      content_index: 2,
      text: "Done only",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "r" },
    },
    {
      ...terminal,
      response: {
        output: [{ type: "reasoning", id: "r", encrypted_content: "native" }],
      },
    },
  ];
  const stream = await (
    await convertResponse(sse(events), options({ stream: true }))
  ).text();
  assert.match(stream, /Done only/);
  assert.match(stream, /"summary_index":2/);
  assert.doesNotMatch(stream, /"content_index"/);
});

test("reference credential and free-quota error variants retain their scope", () => {
  for (const value of [
    { error: "The OAuth2 access token could not be validated." },
    { body: { error: { code: "UNAUTHENTICATED:BAD-CREDENTIALS" } } },
  ])
    assert.equal(xaiBadCredentials(value), true);
  assert.equal(xaiBadCredentials({ error: "Permission denied" }), false);
  const value = {
    error:
      "You've used all the included free usage for model grok-4.7 for now.",
  };
  assert.equal(
    xaiLimit(value, new Headers(), scope.model, 1000).resets_at,
    86401000,
  );
  assert.equal(xaiLimit(value, new Headers(), "grok-4", 1000).model, null);
  assert.equal(
    xaiLimit(
      { ...value, type: "response.output_text.delta" },
      new Headers(),
      scope.model,
    ),
    undefined,
  );
});

test("Grok content_part.done carries reasoning even when no text delta was emitted", async () => {
  const native = { type: "reasoning", id: "r", encrypted_content: "cipher" };
  const result = await (
    await convertResponse(
      sse([
        { type: "response.output_item.added", output_index: 0, item: native },
        {
          type: "response.content_part.done",
          item_id: "r",
          content_index: 0,
          part: { type: "reasoning_text", text: "Final thought" },
        },
        { type: "response.output_item.done", output_index: 0, item: native },
        terminal,
      ]),
      options(),
    )
  ).json();
  assert.equal(result.output[0].summary[0].text, "Final thought");
});

test("device polling recognizes OAuth errors independently of the HTTP status", async () => {
  const client = new XaiClient(async (request) => {
    assert.equal(request.headers.get("accept"), "application/json");
    return Response.json({ error: "slow_down" });
  }, new AbortController().signal);
  assert.deepEqual(
    await client.pollDevice({
      token_endpoint: "https://auth.x.ai/token",
      device_code: "d",
    }),
    { tokens: null, slow: true },
  );
});

test("native search injection is opt-in, deduplicated, allowed and counted at the tool limit", async () => {
  assert.equal((await translate({ input: "x" })).body.tools.length, 0);
  const injected = await translate(
    {
      input: "x",
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [] },
    },
    false,
    { injectSearch: true },
  );
  assert.deepEqual(injected.body.tools, [{ type: "x_search" }]);
  assert.deepEqual(injected.body.tool_choice.tools, [{ type: "x_search" }]);
  assert.equal(
    (
      await translate({ input: "x", tools: [{ type: "x_search" }] }, false, {
        injectSearch: true,
      })
    ).body.tools.length,
    1,
  );
  const namespace = {
    type: "namespace",
    name: "app",
    tools: Array.from({ length: 200 }, (_, i) => ({
      type: "function",
      name: `f${i}`,
    })),
  };
  assert.equal(
    (
      await translate({ input: "x", tools: [namespace] }, false, {
        injectSearch: true,
      })
    ).body.tools.length,
    2,
  );
});

test("unqualified client tools retain their identity beside a namespaced tool of the same name", async () => {
  const result = await translate({
    input: [
      { type: "function_call", name: "lookup", call_id: "c", arguments: "{}" },
    ],
    tools: [
      { type: "function", name: "lookup" },
      {
        type: "namespace",
        name: "app",
        tools: [{ type: "function", name: "lookup" }],
      },
    ],
  });
  assert.equal(result.body.input[0].name, result.tools[0].wireName);
});

test("internal search traces are hidden and Responses output indices are compacted", async () => {
  const trace = {
    id: "xs",
    type: "custom_tool_call",
    name: "x_keyword_search",
    call_id: "xs_call1",
    input: "query",
  };
  const answer = message("answer", "Found it");
  for (const anthropic of [false, true]) {
    const stream = await (
      await convertResponse(
        sse([
          { type: "response.output_item.added", output_index: 0, item: trace },
          {
            type: "response.custom_tool_call_input.delta",
            output_index: 0,
            delta: "query",
          },
          { type: "response.output_item.done", output_index: 0, item: trace },
          { type: "response.output_item.done", output_index: 1, item: answer },
          { ...terminal, response: { output: [trace, answer] } },
        ]),
        options({ anthropic, stream: true, search: true }),
      )
    ).text();
    assert.doesNotMatch(stream, /xs_call|x_keyword_search|"output_index":1/);
    assert.match(stream, /Found it/);
  }
});

function storageFixture() {
  const backend = new MemoryObjectBackend();
  const storage = new BackedObjectStorage(
    backend,
    "test",
    "replay",
    new AlarmState(backend, "test", "replay"),
  );
  return { storage, store: new XaiReplayStore(storage) };
}

test("history store chunks values, fences late completions and expires idle data", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { storage, store } = storageFixture();
  const initial = await store.begin();
  assert.equal(await store.commit(initial.version, "a".repeat(150000)), true);
  assert.equal((await storage.get("xai_replay:0")).length, 65536);
  const next = await new XaiReplayStore(storage).begin();
  assert.equal(next.value.length, 150000);
  assert.equal(await store.commit(initial.version, "late"), false);
  assert.equal(await store.commit(next.version, null), true);
  assert.equal((await store.begin()).value, null);
  t.mock.timers.tick(3600001);
  await store.alarm();
  assert.equal((await storage.list()).size, 0);
});

test("history matches assistant content, fills tool calls and avoids duplicate reasoning", () => {
  const reason = { type: "reasoning", encrypted_content: "secret" };
  const call = {
    type: "function_call",
    call_id: "c",
    name: "f",
    arguments: "{}",
  };
  const output = { type: "function_call_output", call_id: "c", output: "OK" };
  assert.deepEqual(mergeHistory([output], [reason, call]), [
    reason,
    call,
    output,
  ]);
  assert.deepEqual(mergeHistory([reason, call, output], [reason, call]), [
    reason,
    call,
    output,
  ]);
  const changed = [message("a", "Edited")];
  assert.deepEqual(
    mergeHistory(changed, [reason, message("a", "Original")]),
    changed,
  );
  assert.equal(
    historySession(new Request("https://test"), { prompt_cache_key: "key" }),
    "cache:key",
  );
});

test("encrypted history isolates clients and rejects disconnected account provenance", async () => {
  const stores = new Map();
  let generation = 1;
  const view = () =>
    accountViewSchema.parse({
      account_ref: scope.account_ref,
      provider_id: "xai",
      generation,
      status: "ready",
      email: null,
      project_id: null,
      expires_at: null,
      error: null,
      models: [],
      models_updated_at: null,
      models_error: null,
      quota: {
        groups: [],
        subscription: null,
        updated_at: null,
        stale: true,
        last_error: null,
      },
    });
  const env = {
    CONFIG_ENCRYPTION_KEY: key,
    SESSION_AFFINITY: {
      getByName(name) {
        if (!stores.has(name)) stores.set(name, storageFixture().store);
        const store = stores.get(name);
        return {
          beginXaiReplay: () => store.begin(),
          commitXaiReplay: (...args) => store.commit(...args),
        };
      },
    },
    PROVIDER_OAUTH_ACCOUNT: {
      getByName: () => ({ run: async () => ({ ok: true, data: view() }) }),
    },
  };
  const native = {
    type: "reasoning",
    encrypted_content: "raw",
    summary: [{ type: "summary_text", text: "Reason" }],
  };
  const item = {
    ...native,
    encrypted_content: await sealReasoning(native, "Reason", scope, key),
  };
  const finish = await prepareHistory(
    env,
    scope,
    1,
    "session",
    { input: [] },
    [],
    [scope.account_ref],
  );
  await finish([item, message("a", "Answer")]);
  const body = {
    input: [
      message("a", "Answer"),
      { type: "message", role: "user", content: "Continue" },
    ],
  };
  await prepareHistory(env, scope, 1, "session", body, [], [scope.account_ref]);
  assert.equal(body.input[0].encrypted_content, "raw");
  const other = { input: [] };
  await prepareHistory(
    env,
    { ...scope, client_id: "other" },
    1,
    "session",
    other,
    [],
    [scope.account_ref],
  );
  assert.equal(other.input.length, 0);
  generation = 2;
  const afterDisconnect = { input: [] };
  await prepareHistory(
    env,
    scope,
    2,
    "session",
    afterDisconnect,
    [],
    [scope.account_ref],
  );
  assert.equal(afterDisconnect.input.length, 0);
});
