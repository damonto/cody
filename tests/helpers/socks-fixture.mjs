import { createServer as createTcpServer, connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { Duplex } from "node:stream";
import { once } from "node:events";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

export async function certificates(
  hostname = "upstream.test",
  sanHostname = hostname,
) {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const rootKeys = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const serverKeys = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const validity = {
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
  };
  const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
  const root = await X509CertificateGenerator.createSelfSigned({
    name: "CN=Cody test root",
    keys: rootKeys,
    ...validity,
    signingAlgorithm,
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new KeyUsagesExtension(
        KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const leaf = await X509CertificateGenerator.create({
    subject: `CN=${hostname}`,
    issuer: root.subject,
    publicKey: serverKeys.publicKey,
    signingKey: rootKeys.privateKey,
    ...validity,
    signingAlgorithm,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new SubjectAlternativeNameExtension([
        { type: "dns", value: sanHostname },
      ]),
    ],
  });
  const privateKey = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", serverKeys.privateKey),
  ).toString("base64");
  return {
    root: root.toString("pem"),
    cert: leaf.toString("pem"),
    key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`,
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

export function nodeDial({ hostname, port }) {
  const socket = connect({ host: hostname, port });
  const opened = once(socket, "connect");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  const streams = Duplex.toWeb(socket);
  return Promise.resolve({
    ...streams,
    opened,
    closed,
    close: async () => {
      socket.destroy();
    },
  });
}

export async function tlsProxyFixture(handler, options = {}) {
  const credentials = options.credentials;
  const certificate = await certificates(options.hostname, options.sanHostname);
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const upstream = createHttpsServer(
    {
      ...certificate,
      minVersion: "TLSv1.2",
      maxVersion: options.tlsVersion ?? "TLSv1.3",
      ALPNProtocols: ["http/1.1"],
    },
    handler,
  );
  upstream.on("connection", track);
  const upstreamPort = await listen(upstream);
  const destinations = [];
  let connections = 0;
  const proxy = createTcpServer((socket) => {
    track(socket);
    connections += 1;
    const iterator = socket.iterator({ destroyOnReturn: false });
    let buffered = Buffer.alloc(0);
    const read = async (length) => {
      while (buffered.length < length) {
        const part = await iterator.next();
        if (part.done) throw new Error("Client closed during SOCKS5 handshake");
        buffered = Buffer.concat([buffered, part.value]);
      }
      const result = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return result;
    };
    const session = (async () => {
      const greeting = await read(2);
      const methods = await read(greeting[1]);
      const method = credentials ? 2 : 0;
      if (greeting[0] !== 5 || !methods.includes(method)) {
        socket.end(Buffer.from([5, 255]));
        return;
      }
      socket.write(Buffer.from([5, method]));
      if (credentials) {
        const auth = await read(2);
        const username = (await read(auth[1])).toString();
        const password = (await read((await read(1))[0])).toString();
        if (
          username !== credentials.username ||
          password !== credentials.password
        ) {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        socket.write(Buffer.from([1, 0]));
      }
      const command = await read(4);
      const address = await read(
        command[3] === 3 ? (await read(1))[0] : command[3] === 1 ? 4 : 16,
      );
      const port = (await read(2)).readUInt16BE();
      destinations.push({ type: command[3], host: address.toString(), port });
      if (command[0] !== 5 || command[1] !== 1 || port !== upstreamPort) {
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const remote = connect({ host: "127.0.0.1", port: upstreamPort });
      track(remote);
      await once(remote, "connect");
      await iterator.return();
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      if (buffered.length) remote.write(buffered);
      socket.pipe(remote).pipe(socket);
      socket.once("close", () => remote.destroy());
      remote.once("close", () => socket.destroy());
    })();
    void session.catch(() => socket.destroy());
  });
  const port = await listen(proxy);
  return {
    url: `https://upstream.test:${upstreamPort}`,
    proxy: { url: `socks5://127.0.0.1:${port}`, ...credentials },
    options: { dial: nodeDial, trustedCertificates: [certificate.root] },
    destinations,
    get connections() {
      return connections;
    },
    upstream,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    },
  };
}
