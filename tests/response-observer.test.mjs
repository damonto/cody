import assert from "node:assert/strict";
import test from "node:test";
import { ResponseObserver } from "../src/telemetry/response-observer.ts";

const encode = (text) => new TextEncoder().encode(text);

test("response observation reports the resolved format for fragmented UTF-8", () => {
  const value = { text: "你好" };
  for (const format of ["json", "sse"]) {
    for (const detect of [false, true]) {
      const events = [];
      const observer = new ResponseObserver({
        format: detect ? "auto" : format,
        onEvent: (...args) => events.push(args),
        onIssue: assert.fail,
      });
      const body = JSON.stringify(value);
      const bytes = encode(format === "json" ? body : `data: ${body}\n\n`);
      for (const byte of bytes) observer.push(Uint8Array.of(byte));
      observer.end();
      assert.deepEqual(events, [[value, "", format]]);
      assert.equal(observer.format, format);
    }
  }
});

test("ending observation delivers a pending payload once, including reentrant calls", () => {
  for (const body of ['{"done":true}', 'data: {"done":true}']) {
    const events = [];
    const observer = new ResponseObserver({
      format: "auto",
      onEvent: (value) => {
        events.push(value);
        observer.end();
        observer.push(encode(body));
      },
      onIssue: assert.fail,
    });
    observer.push(encode(body));
    assert.deepEqual(events, []);
    observer.end();
    observer.end();
    observer.push(encode(body));
    assert.deepEqual(events, [{ done: true }]);
  }
});

test("discarded observation never delivers buffered or subsequent payloads", () => {
  for (const [prefix, format] of [
    ["dat", undefined],
    ['{"done":true}', "json"],
    ['data: {"done":true}\n', "sse"],
  ]) {
    const observer = new ResponseObserver({
      format: "auto",
      onEvent: assert.fail,
      onIssue: assert.fail,
      onDone: assert.fail,
    });
    observer.push(encode(prefix));
    observer.discard();
    observer.discard();
    observer.push(encode('data: {"late":true}\n\ndata: [DONE]\n\n'));
    observer.end();
    assert.equal(observer.format, format);
  }
});

test("ending malformed or unsupported observation reports one issue with its format", () => {
  for (const [body, issue, format] of [
    ["{", "invalid_response_json", "json"],
    ["data: {", "invalid_sse_json", "sse"],
    ["dat", "unsupported_response_format", undefined],
  ]) {
    const issues = [];
    const observer = new ResponseObserver({
      format: "auto",
      onEvent: assert.fail,
      onIssue: (...args) => {
        issues.push(args);
        observer.end();
      },
    });
    observer.push(encode(body));
    observer.end();
    observer.end();
    assert.deepEqual(issues, [[issue, format]]);
  }
});

test("terminal callback failures propagate without being classified as invalid JSON", () => {
  for (const body of ['{"done":true}', 'data: {"done":true}']) {
    const failure = new Error("observer callback failed");
    let delivered = 0;
    const observer = new ResponseObserver({
      format: "auto",
      onEvent: () => {
        delivered++;
        throw failure;
      },
      onIssue: assert.fail,
    });
    observer.push(encode(body));
    assert.throws(
      () => observer.end(),
      (error) => error === failure,
    );
    observer.end();
    observer.push(encode(body));
    assert.equal(delivered, 1);
  }
});
