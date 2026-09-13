import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { socksFetch } from "../../src/gateway/transport/index.ts";
import type { SocksSocket } from "../../src/gateway/transport/socks.ts";

function frame(
  opcode: number,
  value: string | Uint8Array,
  fin = true,
): Uint8Array {
  const data =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return new Uint8Array([opcode | (fin ? 128 : 0), data.length, ...data]);
}

function fixture(status = 101, stall = false) {
  let source: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let phase = 0;
  let request = "";
  let closes = 0;
  const frames: { opcode: number; masked: boolean; data: Uint8Array }[] = [];
  const send = (data: Uint8Array) => {
    if (!stopped) source.enqueue(data);
  };
  const socket: SocksSocket = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        stopped = true;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      async write(data: Uint8Array) {
        if (phase === 0) {
          expect([...data]).toEqual([5, 1, 0]);
          send(new Uint8Array([5]));
          send(new Uint8Array([0]));
          phase += 1;
        } else if (phase === 1) {
          expect([...data.subarray(0, 4)]).toEqual([5, 1, 0, 3]);
          for (const byte of [5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
            send(new Uint8Array([byte]));
          phase += 1;
        } else if (phase === 2) {
          request = new TextDecoder().decode(data);
          phase += 1;
          if (stall) return;
          if (status !== 101) {
            send(
              new TextEncoder().encode(
                `HTTP/1.1 ${status} Upstream\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n{"error":"quota"}`,
              ),
            );
            return;
          }
          const key = /sec-websocket-key: ([^\r]+)/i.exec(request)?.[1];
          const hash = await crypto.subtle.digest(
            "SHA-1",
            new TextEncoder().encode(
              `${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
            ),
          );
          const accept = Buffer.from(hash).toString("base64");
          const response = new TextEncoder().encode(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Origin: preserved\r\n\r\n`,
          );
          for (const byte of response) send(new Uint8Array([byte]));
        } else {
          expect(data[1] & 127).toBeLessThan(126);
          const mask = data.subarray(2, 6);
          const payload = data
            .subarray(6)
            .map((byte, index) => byte ^ mask[index % 4]);
          const decoded = {
            opcode: data[0] & 15,
            masked: !!(data[1] & 128),
            data: payload,
          };
          frames.push(decoded);
          if (decoded.opcode === 8) send(frame(8, payload));
        }
      },
    }),
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    close() {
      closes += 1;
      if (!stopped) {
        stopped = true;
        source.close();
      }
      return Promise.resolve();
    },
  };
  return {
    dial: async () => socket,
    send,
    frames,
    get request() {
      return request;
    },
    get closes() {
      return closes;
    },
  };
}

const proxy = { url: "socks5://proxy.test:1080" };
const request = (signal?: AbortSignal) =>
  new Request("http://upstream.test/v1/responses?mode=socket", {
    headers: {
      upgrade: "websocket",
      authorization: "Bearer selected-key",
      "x-application": "keep",
    },
    ...(signal ? { signal } : {}),
  });

test("SOCKS5 WebSocket preserves messages, masking, fragmentation, ping/pong and close", async () => {
  const upstream = fixture();
  const response = await socksFetch(request(), proxy, upstream);
  expect(response.status).toBe(101);
  expect(response.headers.get("x-origin")).toBe("preserved");
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  const messages: (string | ArrayBuffer)[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(event.data as string | ArrayBuffer);
  });
  socket.accept();
  expect(upstream.request).toContain("GET /v1/responses?mode=socket HTTP/1.1");
  expect(upstream.request).toContain("Bearer selected-key");
  expect(upstream.request).toMatch(/x-application: keep/i);
  socket.send("client event");
  socket.send(new Uint8Array([1, 2, 3]));
  upstream.send(frame(1, "hel", false));
  upstream.send(frame(9, "ping"));
  upstream.send(frame(0, "lo"));
  upstream.send(frame(2, new Uint8Array([4, 5])));
  await vi.waitFor(() => {
    expect(messages[0]).toBe("hello");
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(
      new Uint8Array([4, 5]),
    );
    expect(
      upstream.frames
        .filter((value) => value.opcode !== 10)
        .map((value) => value.opcode),
    ).toEqual([1, 2]);
    expect(upstream.frames.some((value) => value.opcode === 10)).toBe(true);
  });
  expect(upstream.frames.every((value) => value.masked)).toBe(true);
  expect(
    new TextDecoder().decode(
      upstream.frames.find((value) => value.opcode === 1)!.data,
    ),
  ).toBe("client event");
  expect(
    new TextDecoder().decode(
      upstream.frames.find((value) => value.opcode === 10)!.data,
    ),
  ).toBe("ping");
  socket.close(1000, "finished");
  await vi.waitFor(() => expect(upstream.closes).toBe(1));
  expect(upstream.frames.at(-1)?.opcode).toBe(8);
});

test("a SOCKS5 WebSocket upgrade rejection retains its HTTP error body", async () => {
  const upstream = fixture(403);
  const response = await socksFetch(request(), proxy, upstream);
  expect(response.status).toBe(403);
  expect(response.webSocket).toBeNull();
  expect(await response.json()).toEqual({ error: "quota" });
  expect(upstream.closes).toBe(1);
});

test("cancelling a SOCKS5 WebSocket handshake releases the TCP connection", async () => {
  const upstream = fixture(101, true);
  const controller = new AbortController();
  const result = socksFetch(request(controller.signal), proxy, upstream);
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() =>
    expect(upstream.request).toContain("GET /v1/responses"),
  );
  controller.abort();
  await rejected;
  expect(upstream.closes).toBe(1);
});
