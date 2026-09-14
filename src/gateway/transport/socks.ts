import { isIP } from "node:net";
import type { SocksProxyConfig } from "../../config/types.ts";
import { ByteReader, concatenate, type Connection } from "./bytes.ts";
import { SocksProxyError } from "../proxies/errors.ts";
import { abortable } from "../../shared/abort.ts";

export interface SocksSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<unknown>;
  readonly closed: Promise<unknown>;
  close(): Promise<unknown>;
}
export type SocksDial = (address: {
  hostname: string;
  port: number;
}) => Promise<SocksSocket>;

const ENCODER = new TextEncoder();

async function dialSocks(address: {
  hostname: string;
  port: number;
}): Promise<SocksSocket> {
  const { connect } = await import("cloudflare:sockets");
  return connect(address, { secureTransport: "off", allowHalfOpen: false });
}

function destination(hostname: string): Uint8Array {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 4) {
    return new Uint8Array([1, ...host.split(".").map(Number)]);
  }
  if (isIP(host) === 6) {
    // URL normalizes IPv4-mapped addresses into IPv6 hex groups.
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const [left, right] = normalized.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const groups =
      right === undefined
        ? start
        : [
            ...start,
            ...Array<string>(8 - start.length - end.length).fill("0"),
            ...end,
          ];
    const bytes = new Uint8Array(17);
    bytes[0] = 4;
    groups.forEach((group, index) => {
      const value = Number.parseInt(group, 16);
      bytes[1 + index * 2] = value >> 8;
      bytes[2 + index * 2] = value & 255;
    });
    return bytes;
  }
  const domain = ENCODER.encode(host);
  if (!domain.length || domain.length > 255) {
    throw new SocksProxyError(
      "SOCKS5 destination hostname is too long",
      "target",
    );
  }
  return concatenate([new Uint8Array([3, domain.length]), domain]);
}

/** RFC 1928 CONNECT, with RFC 1929 credentials and DNS resolved by the proxy. */
export async function openSocksTunnel(
  proxy: SocksProxyConfig,
  target: { hostname: string; port: number },
  signal: AbortSignal,
  dial: SocksDial = dialSocks,
): Promise<Connection> {
  signal.throwIfAborted();
  const endpoint = new URL(proxy.url.replace(/^socks5:/, "http:"));
  // Read the port from the SOCKS URL: the HTTP URL parser erases :80.
  const port = Number(new URL(proxy.url).port);
  const dialing = dial({
    hostname: endpoint.hostname.replace(/^\[|\]$/g, ""),
    port,
  });
  let socket: SocksSocket;
  try {
    socket = await abortable(dialing, signal);
  } catch {
    // A dial may resolve after cancellation. It still owns the abandoned socket.
    void dialing.then(
      async (result) => {
        // Closing an unopened socket can reject these lifecycle notifications.
        void result.opened.catch(() => {});
        void result.closed.catch(() => {});
        await Promise.allSettled([result.close()]);
      },
      () => {
        /* The failed dial is reported to the caller below. */
      },
    );
    signal.throwIfAborted();
    throw new SocksProxyError("SOCKS5 TCP connection failed");
  }
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  // read()/write() report I/O failures. These are duplicate lifecycle notifications.
  void socket.closed.catch(() => {});
  void reader.closed.catch(() => {});
  void writer.closed.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      // Peer disconnects may reject teardown; retain the original request error.
      await Promise.allSettled([
        socket.close(),
        reader.cancel(),
        writer.abort(),
      ]);
      reader.releaseLock();
      writer.releaseLock();
    })();
    return closing;
  };
  const onAbort = (): void => {
    // The request or response stream also awaits this same teardown promise.
    void close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const read = async (): Promise<Uint8Array | null> => {
    signal.throwIfAborted();
    const result = await abortable(reader.read(), signal);
    signal.throwIfAborted();
    return result.done ? null : result.value;
  };
  const write = async (data: Uint8Array): Promise<void> => {
    signal.throwIfAborted();
    if (closing) {
      throw new SocksProxyError("SOCKS5 connection is closed");
    }
    await abortable(writer.write(data), signal);
  };
  const bytes = new ByteReader(read);
  try {
    signal.throwIfAborted();
    await abortable(socket.opened, signal);
    signal.throwIfAborted();
    const authenticated = proxy.username !== undefined;
    // With credentials, require authentication instead of permitting a downgrade.
    await write(new Uint8Array([5, 1, authenticated ? 2 : 0]));
    const greeting = await bytes.readExactly(2);
    if (greeting[0] !== 5 || greeting[1] !== (authenticated ? 2 : 0)) {
      throw new SocksProxyError(
        "SOCKS5 proxy rejected the authentication method",
      );
    }
    if (authenticated) {
      const username = ENCODER.encode(proxy.username);
      const password = ENCODER.encode(proxy.password);
      if (
        !username.length ||
        username.length > 255 ||
        !password.length ||
        password.length > 255
      ) {
        throw new SocksProxyError("Invalid SOCKS5 credentials");
      }
      await write(
        concatenate([
          new Uint8Array([1, username.length]),
          username,
          new Uint8Array([password.length]),
          password,
        ]),
      );
      const auth = await bytes.readExactly(2);
      if (auth[0] !== 1 || auth[1] !== 0) {
        throw new SocksProxyError("SOCKS5 authentication failed");
      }
    }
    await write(
      concatenate([
        new Uint8Array([5, 1, 0]),
        destination(target.hostname),
        new Uint8Array([target.port >> 8, target.port & 255]),
      ]),
    );
    const reply = await bytes.readExactly(4);
    if (reply[0] !== 5 || reply[2] !== 0 || reply[1] > 8) {
      throw new SocksProxyError("Invalid SOCKS5 CONNECT response");
    }
    let addressLength: number;
    switch (reply[3]) {
      case 1:
        addressLength = 4;
        break;
      case 4:
        addressLength = 16;
        break;
      case 3:
        addressLength = (await bytes.readExactly(1))[0];
        break;
      default:
        throw new SocksProxyError("Invalid SOCKS5 bound address");
    }
    if (!addressLength) {
      throw new SocksProxyError("Invalid SOCKS5 bound address");
    }
    await bytes.readExactly(addressLength + 2);
    if (reply[1] !== 0) {
      throw new SocksProxyError(
        `SOCKS5 CONNECT failed (reply ${reply[1]})`,
        "target",
      );
    }
    return { read: () => bytes.readSome(), write, close };
  } catch (error) {
    await close();
    signal.throwIfAborted();
    // Socket errors can include endpoint details; protocol errors never contain credentials.
    if (error instanceof SocksProxyError) {
      throw error;
    }
    throw new SocksProxyError("SOCKS5 tunnel could not be established");
  }
}
