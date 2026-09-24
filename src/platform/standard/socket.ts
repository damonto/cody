import { once } from "node:events";
import { connect, type Socket } from "node:net";
import type { SocksDial, SocksSocket } from "../../gateway/transport/socks.ts";

function readableFrom(socket: Socket): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const finish = (): void => {
          try {
            controller.close();
          } catch {
            // Already closed or errored.
          }
        };
        socket.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) socket.pause();
        });
        socket.once("end", finish);
        socket.once("close", finish);
        socket.once("error", (error) => {
          try {
            controller.error(error);
          } catch {
            // Already closed.
          }
        });
      },
      pull() {
        socket.resume();
      },
      cancel() {
        socket.destroy();
      },
    },
    { highWaterMark: 4 },
  );
}

function writableFrom(socket: Socket): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    },
    abort() {
      socket.destroy();
    },
  });
}

/** Plain TCP for SOCKS5 tunnels; TLS to the target still runs inside the tunnel. */
export const nodeSocksDial: SocksDial = async ({ hostname, port }) => {
  const socket = connect({ host: hostname, port, allowHalfOpen: false });
  socket.setNoDelay(true);
  // Errors surface through the streams and the `opened` promise.
  socket.on("error", () => {});
  const result: SocksSocket = {
    readable: readableFrom(socket),
    writable: writableFrom(socket),
    opened: once(socket, "connect"),
    closed: new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    }),
    close: async () => {
      socket.destroy();
    },
  };
  return result;
};
