import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError } from "../src/providers/errors.ts";
import { antigravityAdapter } from "../src/providers/antigravity/index.ts";
import { translateRequest } from "../src/providers/antigravity/request.ts";
import { convertResponse } from "../src/providers/antigravity/response.ts";
import { newAntigravityProvider } from "./helpers/native-provider-fixtures.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const scope = {
  provider_id: "antigravity",
  account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  client_id: "client",
  model: "gemini-3.8-flash",
};
const searchTypes = [
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
];
const messagesSearchTypes = ["web_search_20250305", "web_search_20260209"];
const inspect = {
  type: "function",
  name: "inspect",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const patches = {
  type: "namespace",
  name: "files",
  tools: [{ type: "custom", name: "apply_patch" }],
};
const native = (parts) => ({
  response: {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  },
});
const translate = (payload) =>
  translateRequest(payload, "responses", scope, key);

test("Responses search declarations do not block function, namespace or additional tools", async () => {
  for (const type of searchTypes) {
    const payload = {
      input: "Inspect and patch the file",
      tools: [
        { type, filters: { allowed_domains: ["example.com"] } },
        inspect,
        patches,
        { type: "additional_tools", tools: [{ type }] },
      ],
    };
    const original = structuredClone(payload);
    const result = await translate(payload);
    assert.deepEqual(payload, original);
    assert.deepEqual(
      result.tools.map((tool) => [tool.name, tool.namespace]),
      [
        ["inspect", undefined],
        ["apply_patch", "files"],
      ],
    );
    assert.deepEqual(result.request.tools, [
      { functionDeclarations: result.tools.map((tool) => tool.declaration) },
    ]);
    assert.deepEqual(result.request.toolConfig, {
      functionCallingConfig: { mode: "AUTO" },
    });
  }
});

test("Messages and count_tokens omit typed search without dropping ordinary tools", async () => {
  for (const type of messagesSearchTypes)
    for (const endpoint of ["messages", "messages/count_tokens"]) {
      const result = await translateRequest(
        {
          messages: [{ role: "user", content: "Inspect the file" }],
          tools: [
            { type, name: "web_search", max_uses: 5 },
            { name: "inspect", input_schema: inspect.parameters },
          ],
        },
        endpoint,
        { ...scope, model: "claude-sonnet-4-6" },
        key,
      );
      assert.deepEqual(
        result.request.tools[0].functionDeclarations.map((tool) => tool.name),
        ["inspect"],
      );
      assert.deepEqual(
        result.request.toolConfig,
        endpoint === "messages"
          ? { functionCallingConfig: { mode: "VALIDATED" } }
          : undefined,
      );
    }
});

test("optional search-only requests preserve instructions and conversation without native tools", async () => {
  for (const tool_choice of [undefined, "auto", "none"])
    for (const model of [scope.model, "claude-sonnet-4-6"]) {
      const result = await translateRequest(
        {
          instructions: "Keep the client's instructions",
          input: [
            { role: "user", content: "Earlier question" },
            { role: "assistant", content: "Earlier answer" },
            { role: "user", content: "Continue" },
          ],
          tools: [{ type: "web_search" }],
          tool_choice,
        },
        "responses",
        { ...scope, model },
        key,
      );
      assert.deepEqual(result.tools, []);
      assert.equal(result.request.tools, undefined);
      assert.deepEqual(result.request.systemInstruction.parts, [
        { text: "Keep the client's instructions" },
      ]);
      assert.deepEqual(result.request.contents, [
        { role: "user", parts: [{ text: "Earlier question" }] },
        { role: "model", parts: [{ text: "Earlier answer" }] },
        { role: "user", parts: [{ text: "Continue" }] },
      ]);
    }
});

test("forced native search fails before an agent request can silently lose its requirement", async () => {
  for (const tool_choice of [
    ...searchTypes.map((type) => ({ type })),
    ...messagesSearchTypes.map((type) => ({ type })),
    { type: "tool", name: "web_search" },
  ]) {
    await assert.rejects(
      translate({
        input: "Search",
        tools: [{ type: "web_search" }, inspect],
        tool_choice,
      }),
      (error) =>
        error instanceof ProviderRequestError &&
        error.status === 400 &&
        /do not support native web search/.test(error.message),
    );
  }
  for (const tool_choice of [
    "required",
    { type: "required" },
    { type: "any" },
    {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "web_search" }],
    },
  ])
    await assert.rejects(
      translate({
        input: "Search",
        tools: [{ type: "web_search" }],
        tool_choice,
      }),
      /requires an available function or custom tool/,
    );
});

test("a required mixed request can still select an available function", async () => {
  for (const tool_choice of ["required", { type: "any" }]) {
    const result = await translate({
      input: "Inspect",
      tools: [{ type: "web_search" }, inspect],
      tool_choice,
    });
    assert.deepEqual(result.request.toolConfig, {
      functionCallingConfig: { mode: "ANY" },
    });
    assert.equal(
      result.request.tools[0].functionDeclarations[0].name,
      "inspect",
    );
  }
});

test("functions and custom tools named web_search remain callable", async () => {
  for (const type of ["function", "custom", "tool"]) {
    const result = await translate({
      input: "Call the client's search tool",
      tools: [
        { type: "web_search" },
        {
          ...inspect,
          type: type === "tool" ? "function" : type,
          name: "web_search",
        },
      ],
      tool_choice: { type, name: "web_search" },
    });
    assert.equal(result.tools[0].name, "web_search");
    assert.equal(result.tools[0].custom, type === "custom");
    assert.deepEqual(result.request.toolConfig, {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["web_search"],
      },
    });
  }
});

test("allowed_tools restricts active declarations while preserving all history mappings", async () => {
  for (const mode of ["auto", "required"]) {
    const result = await translate({
      input: "Patch the file",
      tools: [{ type: "web_search" }, inspect, patches],
      tool_choice: {
        type: "allowed_tools",
        mode,
        tools: [
          { type: "web_search" },
          { type: "custom", namespace: "files", name: "apply_patch" },
        ],
      },
    });
    assert.equal(result.tools.length, 2);
    assert.deepEqual(result.request.tools, [
      { functionDeclarations: [result.tools[1].declaration] },
    ]);
    assert.deepEqual(result.request.toolConfig, {
      functionCallingConfig: { mode: mode === "auto" ? "AUTO" : "ANY" },
    });
  }
  const result = await translate({
    input: "Continue",
    tools: [{ type: "web_search" }, inspect],
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "web_search" }],
    },
  });
  assert.equal(result.request.tools, undefined);
  assert.deepEqual(result.request.toolConfig, {
    functionCallingConfig: { mode: "NONE" },
  });
});

test("tool selection resolves client names and namespaces without a native-name fallback", async () => {
  const tools = [
    { type: "namespace", name: "files", tools: [inspect] },
    inspect,
    { type: "web_search" },
  ];
  const declared = await translate({ input: "Inspect", tools });
  for (const [choice, expected] of [
    [{ type: "function", name: "inspect" }, declared.tools[1]],
    [
      { type: "function", name: "inspect", namespace: "files" },
      declared.tools[0],
    ],
    [{ type: "function", name: "files.inspect" }, declared.tools[0]],
  ]) {
    const result = await translate({
      input: "Inspect",
      tools,
      tool_choice: choice,
    });
    assert.deepEqual(
      result.request.toolConfig.functionCallingConfig.allowedFunctionNames,
      [expected.native],
    );
    const allowed = await translate({
      input: "Inspect",
      tools,
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [choice] },
    });
    assert.deepEqual(allowed.request.tools, [
      { functionDeclarations: [expected.declaration] },
    ]);
  }
  for (const choice of [
    { type: "function", name: "inspect", namespace: "missing" },
    { type: "function", name: declared.tools[0].native },
  ])
    await assert.rejects(
      translate({ input: "Inspect", tools, tool_choice: choice }),
      /must name a declared function or custom tool/,
    );
});

test("unknown tool types and invalid selections remain explicit request errors", async () => {
  for (const type of ["web_search_future", "file_search", "computer", "typo"])
    await assert.rejects(
      translate({ input: "Hello", tools: [{ type }] }),
      /Unsupported tool type/,
    );
  for (const tool_choice of [
    true,
    [],
    { type: {} },
    "typo",
    { type: "function", name: "missing" },
    { type: "function", name: "inspect", namespace: [] },
    { type: "allowed_tools", mode: "typo", tools: [] },
    { type: "allowed_tools", mode: "auto", tools: "inspect" },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "file_search" }] },
  ])
    await assert.rejects(
      translate({ input: "Hello", tools: [inspect], tool_choice }),
      (error) => error instanceof ProviderRequestError && error.status === 400,
    );
});

test("completed search history preserves assistant text, signed parts and function results", async () => {
  const tools = [{ type: "web_search" }, inspect];
  const declared = await translate({ input: "Start", tools });
  const parts = [
    { text: "Earlier search answer", thoughtSignature: "text-signature" },
    {
      functionCall: { name: "inspect", id: "call", args: { path: "a.ts" } },
      thoughtSignature: "call-signature",
    },
  ];
  const response = await (
    await convertResponse(Response.json(native(parts)), {
      protocol: "openai",
      stream: false,
      tools: declared.tools,
      scope,
      key,
      model: scope.model,
    })
  ).json();
  const payload = {
    input: [
      { role: "user", content: "Start" },
      {
        type: "web_search_call",
        id: "search",
        status: "completed",
        action: { type: "search", query: "Earlier query" },
      },
      ...response.output,
      { type: "function_call_output", call_id: "call", output: "file content" },
    ],
    tools,
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "web_search" }],
    },
  };
  const original = structuredClone(payload);
  const result = await translate(payload);
  assert.deepEqual(payload, original);
  assert.equal(result.request.tools, undefined);
  assert.deepEqual(result.request.contents[1].parts, parts);
  assert.deepEqual(result.request.contents[2].parts, [
    {
      functionResponse: {
        name: "inspect",
        id: "call",
        response: { output: "file content" },
      },
    },
  ]);
  payload.input[1].status = "in_progress";
  await assert.rejects(translate(payload), /Unsupported Responses input type/);
});

test("adapter keeps the agent envelope and round-trips custom tools with optional search over JSON and SSE", async () => {
  for (const stream of [false, true]) {
    const payload = {
      model: "client-alias",
      input: "Patch",
      tools: [{ type: "web_search" }, patches],
      stream,
    };
    const prepared = await antigravityAdapter.prepare(
      { ...newAntigravityProvider(), id: scope.provider_id },
      {
        type: "oauth",
        provider: "antigravity",
        token: "access",
        project_id: "project",
        account_ref: scope.account_ref,
      },
      {
        request: new Request("https://gateway.test/v1/responses"),
        endpoint: "responses",
        transport: "http",
        protocol: "openai",
        payload,
        model: scope.model,
        clientId: scope.client_id,
      },
      { env: { CONFIG_ENCRYPTION_KEY: key } },
    );
    const body = JSON.parse(prepared.body);
    assert.equal(body.requestType, "agent");
    assert.equal(body.model, scope.model);
    assert.equal(body.request.tools.length, 1);
    assert.equal(body.request.tools[0].googleSearch, undefined);
    const declarations = body.request.tools[0].functionDeclarations;
    assert.equal(declarations.length, 1);
    const value = native([
      {
        functionCall: {
          name: declarations[0].name,
          args: { input: "*** Begin Patch" },
        },
      },
    ]);
    const upstream = stream
      ? new Response(`data: ${JSON.stringify(value)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(value);
    const response = await prepared.transformResponse(upstream);
    const result = stream
      ? (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((event) => event.type === "response.completed").response
      : await response.json();
    assert.equal(result.model, "client-alias");
    assert.deepEqual(
      result.output.map((item) => item.type),
      ["custom_tool_call"],
    );
    assert.equal(result.output[0].namespace, "files");
    assert.equal(result.output[0].name, "apply_patch");
    assert.equal(result.output[0].input, "*** Begin Patch");
  }
});
