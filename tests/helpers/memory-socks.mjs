const reply = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

export function memoryProxy(
  response,
  {
    authenticated = false,
    fragmented = true,
    handshake,
    stall = false,
    keepOpen = false,
    closeGate,
  } = {},
) {
  const data = Buffer.concat([
    handshake ??
      Buffer.concat([
        Buffer.from([5, authenticated ? 2 : 0]),
        ...(authenticated ? [Buffer.from([1, 0])] : []),
        reply,
      ]),
    Buffer.from(response),
  ]);
  let offset = 0;
  let controller;
  let ended = false;
  let closes = 0;
  const writes = [];
  const endpoints = [];
  const closing = Promise.withResolvers();
  const readable = new ReadableStream(
    {
      start(value) {
        controller = value;
      },
      pull(value) {
        if (stall) return;
        if (offset === data.length) {
          if (keepOpen) return;
          ended = true;
          value.close();
          return;
        }
        const next = fragmented ? offset + 1 : data.length;
        value.enqueue(data.subarray(offset, next));
        offset = next;
      },
      cancel() {
        ended = true;
      },
    },
    { highWaterMark: 0 },
  );
  const socket = {
    readable,
    writable: new WritableStream({
      write(chunk) {
        writes.push(Buffer.from(chunk));
      },
    }),
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    close: async () => {
      closes += 1;
      closing.resolve();
      if (!ended) {
        ended = true;
        controller.close();
      }
      await closeGate;
    },
  };
  return {
    writes,
    endpoints,
    socket,
    closing: closing.promise,
    get closes() {
      return closes;
    },
    get consumed() {
      return offset;
    },
    dial: async (address) => {
      endpoints.push(address);
      return socket;
    },
  };
}
