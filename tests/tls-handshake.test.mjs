import assert from "node:assert/strict";
import test from "node:test";
import { TlsHandshakeReader } from "../src/gateway/transport/tls-handshake.ts";

test("TLS handshake limits hold across fragmented message headers and bodies", () => {
  const messages = new Uint8Array([
    11, 0, 0, 5, 255, 255, 255, 255, 255, 20, 0, 0, 2, 255, 255,
  ]);
  for (const size of [1, 2, 3, 4, 16]) {
    const reader = new TlsHandshakeReader();
    for (let offset = 0; offset < messages.length; offset += size) {
      assert.equal(
        reader.inspect(messages.subarray(offset, offset + size), false),
        false,
      );
    }
    assert.throws(
      () => reader.inspect(new Uint8Array([4, 4, 0, 1]), true),
      /exceeds its limit/,
    );
  }
});

test("oversized TLS handshake declarations are rejected before buffering their payload", () => {
  for (const established of [false, true]) {
    const reader = new TlsHandshakeReader();
    assert.equal(reader.inspect(new Uint8Array([4, 255]), established), false);
    assert.throws(
      () => reader.inspect(new Uint8Array([255, 255]), established),
      /exceeds its limit/,
    );
  }
});

test("TLS key updates request a reciprocal update only after a complete valid message", () => {
  const reader = new TlsHandshakeReader();
  assert.equal(reader.inspect(new Uint8Array([24, 0]), true), false);
  assert.equal(reader.inspect(new Uint8Array([0, 1]), true), false);
  assert.equal(reader.inspect(new Uint8Array([1]), true), true);
  assert.equal(reader.inspect(new Uint8Array([24, 0, 0, 1, 0]), true), false);
  assert.equal(
    reader.inspect(new Uint8Array([4, 0, 0, 2, 24, 1, 24, 0, 0, 1, 1]), true),
    true,
  );
});

test("invalid TLS key updates and unsupported post-handshake messages fail closed", () => {
  for (const [message, established] of [
    [[24, 0, 0, 1, 1], false],
    [[24, 0, 0, 0], true],
    [[24, 0, 0, 2, 0, 0], true],
    [[24, 0, 0, 1, 2], true],
    [[11, 0, 0, 1, 0], true],
    [[13, 0, 0, 1, 0], true],
  ]) {
    assert.throws(
      () =>
        new TlsHandshakeReader().inspect(new Uint8Array(message), established),
      /Invalid upstream TLS key update|Unsupported upstream TLS post-handshake message/,
    );
  }
});
