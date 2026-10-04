import { newAntigravityProvider } from "./helpers/native-provider-fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { translateRequest } from "../src/providers/antigravity/request.ts";
import { antigravityAdapter } from "../src/providers/antigravity/index.ts";
import {
  INTERLEAVED_THINKING_HINT,
  antigravitySystemParts,
} from "../src/providers/antigravity/request-policy.ts";
import {
  ANTIGRAVITY_VERSION_KEY,
  antigravityVersion,
  antigravityUserAgent,
  refreshAntigravityVersion,
} from "../src/providers/antigravity/version.ts";
import {
  settingsFormValues,
  applySettings,
  applyAccount,
  newAccount,
} from "../console/src/features/antigravity/form-options.ts";
import {
  antigravityProviderSchema,
  aiGatewayProviderSchema,
  codexProviderFormSchema,
  claudeProviderFormSchema,
} from "../src/config/schema.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const scope = {
  provider_id: "antigravity",
  client_id: "client",
  account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  model: "claude-sonnet-4-5-thinking",
};
const tool = { name: "read", input_schema: { type: "object", properties: {} } };
function payload() {
  return {
    system: "Follow user instructions",
    messages: [{ role: "user", content: "hello" }],
    tools: [tool],
    thinking: { type: "enabled", budget_tokens: 4096 },
  };
}
function store() {
  const data = new Map();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

test("only the reference's Messages tool/thinking combinations add the hint", async () => {
  for (const [model, changes, expected] of [
    [scope.model, {}, true],
    [scope.model, { thinking: { type: "adaptive" } }, true],
    [scope.model, { thinking: { type: "auto" } }, true],
    [scope.model, { thinking: { type: "disabled" } }, false],
    [scope.model, { output_config: { effort: "none" } }, false],
    [scope.model, { tools: [] }, false],
    [scope.model, { tool_choice: "none" }, false],
    [scope.model, { tool_choice: { type: "none" } }, false],
    ["claude-sonnet-4-5", {}, false],
    ["gemini-3-pro", {}, false],
  ]) {
    const result = await translateRequest(
      { ...payload(), ...changes },
      "messages",
      { ...scope, model },
      key,
    );
    assert.equal(
      result.request.systemInstruction.parts.some(
        (part) => part.text === INTERLEAVED_THINKING_HINT,
      ),
      expected,
      `${model} ${JSON.stringify(changes)}`,
    );
  }
  const result = await translateRequest(
    {
      input: "hello",
      instructions: "System",
      tools: [tool],
      thinking: { type: "enabled" },
    },
    "responses",
    scope,
    key,
  );
  assert.deepEqual(result.request.systemInstruction.parts, [
    { text: "System" },
  ]);
});

test("masking handles Unicode, literals and overlap without touching history or tool arguments", async () => {
  const input = {
    ...payload(),
    system: "Proxy server PROXY [a.b] 你好世界 😀你好",
    messages: [
      { role: "user", content: "Proxy server" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call",
            name: "read",
            input: { path: "Proxy server" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call", content: "PROXY" },
        ],
      },
    ],
  };
  const before = structuredClone(input);
  const result = await translateRequest(
    input,
    "messages",
    scope,
    key,
    undefined,
    undefined,
    ["proxy", "Proxy server", "[a.b]", "你好", "😀你", "x", "p\u200broxy"],
  );
  assert.equal(
    result.request.systemInstruction.parts[0].text,
    "P\u200broxy server P\u200bROXY [\u200ba.b] 你\u200b好世界 😀\u200b你好",
  );
  assert.equal(result.request.contents[0].parts[0].text, "Proxy server");
  assert.deepEqual(result.request.contents[1].parts[0].functionCall.args, {
    path: "Proxy server",
  });
  assert.deepEqual(input, before);
  const original = [{ text: INTERLEAVED_THINKING_HINT }];
  assert.equal(antigravitySystemParts(original, true).length, 1);
});

test("Messages billing attribution is removed without dropping the client's system text", async () => {
  const result = await translateRequest(
    {
      ...payload(),
      system: [
        {
          type: "text",
          text: "  x-anthropic-billing-header: cc_version=example",
        },
        { type: "text", text: "Keep me" },
      ],
      tools: [],
    },
    "messages",
    scope,
    key,
  );
  assert.deepEqual(result.request.systemInstruction.parts, [
    { text: "Keep me" },
  ]);
});

test("sensitive words save independently of accounts and stay Antigravity-only", () => {
  const provider = newAntigravityProvider();
  const saved = applySettings(provider, {
    ...settingsFormValues(provider),
    sensitive_words: [" Proxy ", "你好"],
  });
  assert.deepEqual(saved.sensitive_words, ["Proxy", "你好"]);
  const account = newAccount();
  account.auth.account_ref = scope.account_ref;
  assert.deepEqual(
    applyAccount(saved, account).sensitive_words,
    saved.sensitive_words,
  );
  assert.deepEqual(
    settingsFormValues(saved).sensitive_words,
    saved.sensitive_words,
  );
  for (const sensitive_words of [
    [""],
    [42],
    Array(129).fill("word"),
    ["x".repeat(257)],
  ])
    assert.equal(
      antigravityProviderSchema.safeParse({ ...provider, sensitive_words })
        .success,
      false,
    );
  for (const schema of [
    aiGatewayProviderSchema,
    codexProviderFormSchema,
    claudeProviderFormSchema,
  ])
    assert.equal(Object.hasOwn(schema.shape, "sensitive_words"), false);
});

test("updater caches only a valid bounded version and never forwards credentials", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const cache = store();
  let requests = 0;
  const send = async (request) => {
    requests++;
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("user-agent"), "electron-builder");
    assert.equal(request.redirect, "manual");
    return new Response("version: '2.10.3'\nfiles:\n  - url: ignored.zip\n");
  };
  assert.equal(await antigravityVersion(cache), "2.9.1");
  await refreshAntigravityVersion(cache, send);
  assert.equal(await antigravityVersion(cache), "2.10.3");
  await refreshAntigravityVersion(cache, send);
  assert.equal(requests, 1);
  t.mock.timers.tick(3 * 60 * 60_000);
  for (const body of [
    "version: evil\n",
    "version: 2.10.4\nversion: 2.10.5\n",
    "x".repeat(4097),
  ]) {
    await refreshAntigravityVersion(cache, async () => new Response(body));
    assert.equal(await antigravityVersion(cache), "2.10.3");
  }
  t.mock.timers.tick(3 * 60 * 60_000 + 1);
  assert.equal(await antigravityVersion(cache), "2.9.1");
  cache.data.set(ANTIGRAVITY_VERSION_KEY, "invalid");
  assert.equal(await antigravityVersion(cache), "2.9.1");
});

test("adapter uses cached native UA and drops client SDK fingerprints", async () => {
  const cache = store();
  cache.data.set(
    ANTIGRAVITY_VERSION_KEY,
    JSON.stringify({ version: "2.12.1", expires_at: Date.now() + 60_000 }),
  );
  const provider = newAntigravityProvider();
  const result = await antigravityAdapter.prepare(
    provider,
    {
      token: "upstream",
      project_id: "project",
      account_ref: scope.account_ref,
    },
    {
      request: new Request("https://gateway/v1/messages", {
        headers: {
          "user-agent": "claude-code",
          "x-stainless-lang": "js",
          "x-api-key": "client-secret",
          "anthropic-version": "2023-06-01",
          "session-id": "session",
        },
      }),
      endpoint: "messages",
      payload: { ...payload(), model: scope.model },
      model: scope.model,
      clientId: scope.client_id,
    },
    { env: { CODY_CONFIG_KV: cache, CONFIG_ENCRYPTION_KEY: key } },
  );
  assert.deepEqual(Object.fromEntries(result.headers), {
    authorization: "Bearer upstream",
    "content-type": "application/json",
    "user-agent": antigravityUserAgent("2.12.1"),
  });
  assert.equal(JSON.parse(result.body).requestType, "agent");
});

test("cold and stale caches refresh in waitUntil without delaying inference", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const cache = store();
  const tasks = [];
  let finish;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const context = { waitUntil: (promise) => tasks.push(promise) };
  assert.equal(await antigravityVersion(cache, context), "2.9.1");
  assert.equal(await antigravityVersion(cache, context), "2.9.1");
  assert.equal(tasks.length, 1);
  assert.equal(fetches, 1);
  finish(new Response("version: 2.12.1\n"));
  await Promise.all(tasks);
  assert.equal(await antigravityVersion(cache, context), "2.12.1");
  t.mock.timers.tick(3 * 60 * 60_000);
  assert.equal(await antigravityVersion(cache, context), "2.12.1");
  assert.equal(tasks.length, 2);
  assert.equal(await antigravityVersion(cache, context), "2.12.1");
  assert.equal(fetches, 2);
  finish(new Response("version: invalid\n"));
  await Promise.all(tasks);
  assert.equal(await antigravityVersion(cache, context), "2.12.1");
  assert.equal(tasks.length, 2);
});

test("an unavailable version cache cannot indefinitely block inference", async () => {
  const unavailable = { ...store(), get: () => new Promise(() => {}) };
  let timer;
  const result = await Promise.race([
    antigravityVersion(unavailable),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("still waiting"), 500);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(result, "2.9.1");
});

test("a cancelled refresh stops waiting on storage and never starts a late manifest request", async () => {
  const cancellation = new AbortController();
  let finish;
  const cache = {
    ...store(),
    get: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  let requests = 0;
  const refresh = refreshAntigravityVersion(
    cache,
    async () => {
      requests++;
      return new Response("version: 2.12.1\n");
    },
    cancellation.signal,
  );
  cancellation.abort(new Error("refresh deadline"));
  await refresh;
  finish(null);
  await Promise.resolve();
  assert.equal(requests, 0);
  assert.equal(cache.data.size, 0);
});

test("failed background registration preserves the usable cached version and cancels refresh", async (t) => {
  const cache = store();
  cache.data.set(
    ANTIGRAVITY_VERSION_KEY,
    JSON.stringify({ version: "2.12.1", expires_at: Date.now() + 60_000 }),
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("version: 2.13.0\n");
  });
  let task;
  const context = {
    waitUntil: (value) => {
      task = value;
      throw new Error("context closed");
    },
  };
  assert.equal(await antigravityVersion(cache, context), "2.12.1");
  await task;
  assert.equal(requests, 0);
  assert.equal(await antigravityVersion(cache), "2.12.1");
});
