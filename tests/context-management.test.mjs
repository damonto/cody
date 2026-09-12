import assert from "node:assert/strict";
import test from "node:test";
import {
  contextManagementRequested,
  parseContextManagementSession,
} from "../src/gateway/sessions/context-management-protocol.ts";

test("history ingestion is recognized in HTTP and WebSocket Codex metadata", () => {
  const metadata = JSON.stringify({ history_ingest_requested: true });
  assert.equal(
    contextManagementRequested({
      client_metadata: { "x-codex-turn-metadata": metadata },
    }),
    true,
  );
  assert.equal(contextManagementRequested({}), false);
  for (const value of [
    undefined,
    "not json",
    "null",
    "[]",
    "true",
    JSON.stringify({ history_ingest_requested: false }),
    JSON.stringify({ history_ingest_requested: "true" }),
  ]) {
    assert.equal(
      contextManagementRequested({
        client_metadata: { "x-codex-turn-metadata": value },
      }),
      false,
    );
  }
});

test("native tool routing requires a consistent context identity without requiring a model", () => {
  const body = JSON.stringify({
    context: { session_id: "session", current_agent_name: "/root" },
    text: "encrypted-value",
  });
  assert.equal(parseContextManagementSession(body, null), "session");
  assert.equal(parseContextManagementSession(body, "session"), "session");
  assert.throws(
    () => parseContextManagementSession(body, "other"),
    /must match/,
  );
  for (const invalid of [
    "not-json",
    "null",
    "[]",
    "{}",
    '{"context":{"session_id":"session"}}',
  ]) {
    assert.throws(() => parseContextManagementSession(invalid, null));
  }
});
