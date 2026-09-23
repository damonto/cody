import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_CORE_TOOLS,
  CLAUDE_CODE_PROMPT_PREFIX,
  emulateClaudeCodeRequest,
  isUuid,
  syntheticClaudeCodeIdentity,
} from "../src/providers/claude-code.ts";

const ATTRIBUTION =
  "x-anthropic-billing-header: cc_version=2.1.278.b3a; cc_entrypoint=cli;";
const SDK_PREFIX =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SESSION = "0f5a2b1c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const identity = { device_id: "synthetic-device", session_id: SESSION };
const prefixBlock = { type: "text", text: CLAUDE_CODE_PROMPT_PREFIX };
const custom = { type: "text", text: "You are a classifier." };
const stub = (name) => ({
  name,
  description: "Not available in this request.",
  input_schema: { type: "object", properties: {} },
});
const tool = (name) => ({ name, description: "real", input_schema: {} });
const coreTools = ["Bash", "Read", "Edit"].map(tool);

function userId(fields) {
  return JSON.stringify({
    device_id: "device-1",
    account_uuid: "",
    session_id: SESSION,
    ...fields,
  });
}

test("a request shaped like Claude Code's main loop is left untouched", () => {
  for (const system of [
    [
      { type: "text", text: ATTRIBUTION },
      { type: "text", text: SDK_PREFIX },
    ],
    [
      { type: "text", text: ATTRIBUTION },
      { ...prefixBlock, cache_control: { type: "ephemeral" } },
      { type: "text", text: "rest" },
    ],
    [prefixBlock, custom],
    [{ type: "text", text: `${SDK_PREFIX} Extra words.` }],
  ]) {
    assert.equal(
      emulateClaudeCodeRequest(
        { system, metadata: { user_id: userId() }, tools: coreTools },
        identity,
      ),
      undefined,
      JSON.stringify(system),
    );
  }
});

test("the prompt prefix is inserted where the upstream expects it", () => {
  const conforming = { metadata: { user_id: userId() }, tools: coreTools };
  const cases = [
    // Claude Code's side queries: attribution first, prefix skipped.
    [
      [{ type: "text", text: ATTRIBUTION }, custom],
      [{ type: "text", text: ATTRIBUTION }, prefixBlock, custom],
    ],
    [[custom], [prefixBlock, custom]],
    [
      [custom, prefixBlock],
      [prefixBlock, custom, prefixBlock],
    ],
    ["plain prompt", [prefixBlock, { type: "text", text: "plain prompt" }]],
    [undefined, [prefixBlock]],
    [[], [prefixBlock]],
    // A prefix that trails another block is not where the upstream looks.
    [
      [{ type: "text", text: ATTRIBUTION }, custom, prefixBlock],
      [{ type: "text", text: ATTRIBUTION }, prefixBlock, custom, prefixBlock],
    ],
  ];
  for (const [system, expected] of cases) {
    const emulated = emulateClaudeCodeRequest(
      { ...conforming, ...(system === undefined ? {} : { system }) },
      identity,
    );
    assert.deepEqual(emulated.system, expected, JSON.stringify(system));
    assert.deepEqual(emulated.metadata, conforming.metadata);
    assert.equal(emulated.tools, coreTools);
  }
});

test("metadata gains a device and UUID session only when the request's own are unusable", () => {
  const conforming = { system: [prefixBlock], tools: coreTools };
  const emulate = (metadata) =>
    emulateClaudeCodeRequest(
      { ...conforming, ...(metadata === undefined ? {} : { metadata }) },
      identity,
    )?.metadata;
  assert.equal(emulate({ user_id: userId() }), undefined);
  assert.equal(emulate({ user_id: userId({ device_id: "d" }) }), undefined);
  // No metadata, a plain user id, or unparseable JSON: fully synthetic.
  const synthetic = JSON.stringify({
    device_id: identity.device_id,
    account_uuid: "",
    session_id: SESSION,
  });
  assert.deepEqual(emulate(undefined), { user_id: synthetic });
  assert.deepEqual(emulate({ user_id: "user-1", other: 1 }), {
    user_id: synthetic,
    other: 1,
  });
  assert.deepEqual(emulate({ user_id: "{not json" }), { user_id: synthetic });
  assert.deepEqual(emulate({}), { user_id: synthetic });
  // Usable parts of the request's own JSON survive.
  assert.deepEqual(
    emulate({ user_id: JSON.stringify({ device_id: "own", session_id: "s" }) }),
    {
      user_id: JSON.stringify({
        device_id: "own",
        account_uuid: "",
        session_id: SESSION,
      }),
    },
  );
  assert.deepEqual(
    emulate({
      user_id: JSON.stringify({
        account_uuid: "acct",
        session_id: "7d2f9c3e-1a4b-4c5d-8e6f-0a1b2c3d4e5f",
        extra: true,
      }),
    }),
    {
      user_id: JSON.stringify({
        device_id: identity.device_id,
        account_uuid: "acct",
        extra: true,
        session_id: "7d2f9c3e-1a4b-4c5d-8e6f-0a1b2c3d4e5f",
      }),
    },
  );
  assert.deepEqual(emulate({ user_id: JSON.stringify({ device_id: "" }) }), {
    user_id: synthetic,
  });
});

test("core tools are added only when fewer than three are declared", () => {
  const conforming = { system: [prefixBlock], metadata: { user_id: userId() } };
  const emulate = (extra) =>
    emulateClaudeCodeRequest({ ...conforming, ...extra }, identity);

  const none = emulate({});
  assert.deepEqual(none.tools, CLAUDE_CODE_CORE_TOOLS.map(stub));
  assert.deepEqual(none.tool_choice, { type: "none" });
  const empty = emulate({ tools: [] });
  assert.deepEqual(empty.tools, CLAUDE_CODE_CORE_TOOLS.map(stub));
  assert.deepEqual(empty.tool_choice, { type: "none" });
  // A request that offered no tools but chose explicitly keeps its choice.
  assert.deepEqual(emulate({ tool_choice: { type: "auto" } }).tool_choice, {
    type: "auto",
  });

  const few = emulate({
    tools: [tool("mcp__x"), tool("Bash")],
    tool_choice: { type: "any" },
  });
  assert.deepEqual(few.tools, [
    tool("mcp__x"),
    tool("Bash"),
    ...["Read", "Edit", "Write", "Glob", "Grep"].map(stub),
  ]);
  // The client's own tools stay callable, so its tool choice is respected.
  assert.deepEqual(few.tool_choice, { type: "any" });
  assert.equal(emulate({ tools: [tool("mcp__x")] }).tool_choice, undefined);

  assert.equal(emulate({ tools: coreTools }), undefined);
  assert.equal(
    emulate({ tools: ["Bash", "Glob", "Grep"].map(tool) }),
    undefined,
  );
});

test("a connection test gains all three requirements at once", () => {
  const emulated = emulateClaudeCodeRequest(
    { model: "m", max_tokens: 1, messages: [{ role: "user", content: "." }] },
    identity,
  );
  assert.deepEqual(emulated, {
    model: "m",
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
    system: [prefixBlock],
    metadata: {
      user_id: JSON.stringify({
        device_id: identity.device_id,
        account_uuid: "",
        session_id: SESSION,
      }),
    },
    tools: CLAUDE_CODE_CORE_TOOLS.map(stub),
    tool_choice: { type: "none" },
  });
});

test("emulateClaudeCodeRequest does not mutate its input", () => {
  const payload = {
    system: [custom],
    tools: [],
    metadata: { user_id: "user-1" },
  };
  const snapshot = structuredClone(payload);
  emulateClaudeCodeRequest(payload, identity);
  assert.deepEqual(payload, snapshot);
});

test("synthetic identities are stable per client and adopt a UUID session", async () => {
  const first = await syntheticClaudeCodeIdentity("client-a");
  assert.match(first.device_id, /^[0-9a-f]{64}$/);
  assert.ok(isUuid(first.session_id));
  assert.match(first.session_id, /^.{14}4.{4}[89ab]/);
  assert.deepEqual(await syntheticClaudeCodeIdentity("client-a"), first);
  const other = await syntheticClaudeCodeIdentity("client-b");
  assert.notEqual(other.device_id, first.device_id);
  assert.notEqual(other.session_id, first.session_id);
  assert.deepEqual(await syntheticClaudeCodeIdentity("client-a", SESSION), {
    device_id: first.device_id,
    session_id: SESSION,
  });
  assert.deepEqual(
    await syntheticClaudeCodeIdentity("client-a", "not-a-uuid"),
    first,
  );
  assert.equal(isUuid(SESSION.toUpperCase()), true);
  assert.equal(isUuid("0f5a2b1c3d4e4f608a7b9c0d1e2f3a4b"), false);
  assert.equal(isUuid(undefined), false);
});
