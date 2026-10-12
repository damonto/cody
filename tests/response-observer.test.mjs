import assert from "node:assert/strict";
import test from "node:test";
import { ResponseObserver } from "../src/telemetry/response-observer.ts";

const encode = (text) => new TextEncoder().encode(text);

for (const format of ["json", "sse"]) {
  test(`${format} observation accepts the shared 16 MiB limit and rejects larger payloads`, () => {
    for (const extra of [0, 1]) {
      const usage = { input_tokens: 10, output_tokens: 20 };
      const prefix = '{"data":[{"b64_json":"';
      const suffix = `"}],"usage":${JSON.stringify(usage)}}`;
      const imageLength =
        16 * 1024 * 1024 - prefix.length - suffix.length + extra;
      const payload = prefix + "a".repeat(imageLength) + suffix;
      const bytes = encode(
        format === "json" ? payload : `data: ${payload}\n\n`,
      );
      const events = [];
      const issues = [];
      const observer = new ResponseObserver({
        format: "auto",
        onEvent: (value) => {
          assert.equal(value.data[0].b64_json.length, imageLength);
          events.push(value.usage);
        },
        onIssue: (issue) => issues.push(issue),
      });
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
        observer.push(bytes.subarray(offset, offset + 64 * 1024));
      observer.end();
      assert.deepEqual(events, extra ? [] : [usage]);
      assert.deepEqual(
        issues,
        extra
          ? [format === "json" ? "json_body_too_large" : "sse_event_too_large"]
          : [],
      );
      assert.equal(observer.format, format);
    }
  });
}

test("JSON observation counts raw UTF-8 bytes across format detection and chunk boundaries", () => {
  const value = { text: "你好🌍" };
  const bytes = encode(" \n" + JSON.stringify(value));
  for (const format of ["json", "auto"]) {
    for (const chunkSize of [1, 7, bytes.length]) {
      for (const extra of [0, 1]) {
        const events = [];
        const issues = [];
        const observer = new ResponseObserver({
          format,
          maxPayloadBytes: bytes.length - extra,
          onEvent: (value) => events.push(value),
          onIssue: (issue) => issues.push(issue),
        });
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          observer.push(bytes.subarray(offset, offset + chunkSize));
        observer.end();
        observer.end();
        observer.push(encode("{}"));
        assert.deepEqual(events, extra ? [] : [value]);
        assert.deepEqual(issues, extra ? ["json_body_too_large"] : []);
      }
    }
  }
});

test("SSE byte limits are independent of UTF-8, CRLF and data-field chunk boundaries", () => {
  const value = { text: "你好🌍" };
  const fields = ['{"text":', '"你好🌍"}'];
  for (const lines of [[JSON.stringify(value)], fields]) {
    const limit = encode(lines.join("\n")).byteLength;
    for (const ending of ["\n", "\r\n", "\r"]) {
      const bytes = encode(
        lines.map((line) => `data: ${line}${ending}`).join("") + ending,
      );
      for (const chunkSize of [1, 7, bytes.length - 2, bytes.length]) {
        for (const extra of [0, 1]) {
          const events = [];
          const issues = [];
          const observer = new ResponseObserver({
            format: "auto",
            maxPayloadBytes: limit - extra,
            onEvent: (value) => events.push(value),
            onIssue: (issue) => issues.push(issue),
          });
          for (let offset = 0; offset < bytes.length; offset += chunkSize)
            observer.push(bytes.subarray(offset, offset + chunkSize));
          // A fresh event must still be observed after an oversized one.
          observer.push(encode("data: {}\n\n"));
          observer.end();
          assert.deepEqual(events, extra ? [{}] : [value, {}]);
          assert.deepEqual(issues, extra ? ["sse_event_too_large"] : []);
        }
      }
    }
  }
});

test("SSE accepts a full data line before its newline arrives", () => {
  const value = { done: true };
  const payload = JSON.stringify(value);
  const events = [];
  const observer = new ResponseObserver({
    format: "sse",
    maxPayloadBytes: encode(payload).byteLength,
    onEvent: (event) => events.push(event),
    onIssue: assert.fail,
  });
  observer.push(encode(`data: ${payload}`));
  observer.push(encode("\n\n"));
  observer.end();
  assert.deepEqual(events, [value]);
});

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
