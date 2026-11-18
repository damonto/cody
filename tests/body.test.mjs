import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  MAX_INFERENCE_BODY_BYTES,
  MAX_VERCEL_REQUEST_BODY_BYTES,
} from "../src/shared/payload-limits.ts";

import {
  BodyTooLargeError,
  readBodyWithinLimit,
} from "../src/gateway/http/body.ts";
import { handleInference } from "../src/gateway/http/proxy.ts";

const encoder = new TextEncoder();

test("bounded body reading accepts a stream exactly at the limit", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("123"));
      controller.enqueue(encoder.encode("45"));
      controller.close();
    },
  });

  const body = await readBodyWithinLimit(stream, 5);
  assert.equal(new TextDecoder().decode(body), "12345");
});

test("bounded body reading rejects and cancels a stream that exceeds the actual limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("1234"));
      controller.enqueue(encoder.encode("56"));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBodyWithinLimit(stream, 5),
    (error) => error instanceof BodyTooLargeError && error.maxBytes === 5,
  );
  assert.equal(cancelled, true);
});

test("bounded body reading rejects declared oversize bodies before consuming them", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBodyWithinLimit(stream, 5, "6"),
    (error) => error instanceof BodyTooLargeError && error.maxBytes === 5,
  );
  assert.equal(cancelled, true);
});

test("inference requests larger than 64 MiB return an OpenAI-compatible 413", async () => {
  assert.equal(MAX_INFERENCE_BODY_BYTES, 64 * 1024 * 1024);
  const request = new Request("https://gateway.example/v1/responses", {
    method: "POST",
    headers: {
      "content-length": String(MAX_INFERENCE_BODY_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });
  const response = await handleInference(
    request,
    {},
    { providers: [], api_keys: [], model_routes: {} },
    { id: "client", api_key: "client", providers: [] },
    "responses",
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "request_too_large");
});

test("deployment upload limits reject declared and actual oversize bodies", async () => {
  for (const declared of [false, true]) {
    const response = await handleInference(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: declared
          ? { "content-length": String(MAX_VERCEL_REQUEST_BODY_BYTES + 1) }
          : {},
        body: declared ? "{}" : "x".repeat(MAX_VERCEL_REQUEST_BODY_BYTES + 1),
      }),
      { REQUEST_BODY_LIMIT_BYTES: MAX_VERCEL_REQUEST_BODY_BYTES },
      { providers: [], api_keys: [], model_routes: {} },
      { id: "client", api_key: "client", providers: [] },
      "responses",
    );
    assert.equal(response.status, 413);
    const { error } = await response.json();
    assert.equal(error.code, "request_too_large");
    assert.match(error.message, /4\.5 MB/);
  }
});

test("deployment upload limits also bound decompression", async () => {
  const response = await handleInference(
    new Request("https://gateway.example/v1/responses", {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: zstdCompressSync(encoder.encode("x".repeat(129))),
    }),
    { REQUEST_BODY_LIMIT_BYTES: 128 },
    { providers: [], api_keys: [], model_routes: {} },
    { id: "client", api_key: "client", providers: [] },
    "responses",
  );
  assert.equal(response.status, 413);
  assert.match((await response.json()).error.message, /128 bytes/);
});
