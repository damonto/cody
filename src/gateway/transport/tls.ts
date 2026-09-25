import {
  makeTLSClient,
  setCryptoImplementation,
  loadX509FromPem,
  MAX_ENC_PACKET_SIZE,
  type CipherSuite,
} from "@reclaimprotocol/tls";
import { webcryptoCrypto } from "@reclaimprotocol/tls/webcrypto";
import { ByteReader, concatenate, type Connection } from "./bytes.ts";
import { validatePeerCertificates } from "./certificates.ts";
import { TlsHandshakeReader } from "./tls-handshake.ts";

setCryptoImplementation(webcryptoCrypto);

const CIPHER_SUITES: readonly CipherSuite[] = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
];
// The TLS library's diagnostic logger can print plaintext and key material.
const SILENT_TLS_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
};

/** Pull-driven TLS: at most one encrypted record and one plaintext record are queued. */
export async function secureConnection(
  connection: Connection,
  hostname: string,
  trustedCertificates: readonly string[] = [],
): Promise<Connection> {
  const reader = new ByteReader(() => connection.read());
  const roots = trustedCertificates.map(loadX509FromPem);
  const plaintext: Uint8Array[] = [];
  const handshakes = new TlsHandshakeReader();
  let failure: Error | undefined;
  let ended = false;
  let closing: Promise<void> | undefined;
  let verified = false;
  let handshakeBytes = 0;
  let updateRequested = false;
  let keyUpdateQueued = false;
  let writes = Promise.resolve();
  const tls = makeTLSClient({
    host: hostname.replace(/^\[|\]$/g, ""),
    verifyServerCertificate: true,
    rootCAs: roots,
    cipherSuites: [...CIPHER_SUITES],
    supportedProtocolVersions: ["TLS1_3", "TLS1_2"],
    namedCurves: ["SECP256R1", "SECP384R1"],
    applicationLayerProtocols: ["http/1.1"],
    logger: SILENT_TLS_LOGGER,
    fetchCertificateBytes() {
      // A certificate must not cause a direct request outside the selected proxy.
      throw new Error(
        "Upstream must provide its complete TLS certificate chain",
      );
    },
    async write({ header, content }) {
      // A record is not usable until its payload arrives. Sending the five-byte
      // header separately adds tiny TCP writes and can trigger delayed ACKs.
      await connection.write(concatenate([header, content]));
    },
    onRead({ content, header }, context) {
      const metadata = tls.getMetadata();
      if (
        context.type === "ciphertext" &&
        metadata.version === "TLS1_3" &&
        !context.contentType
      ) {
        // This engine cannot decode padded TLS 1.3 records. Never expose their
        // inner content-type or padding as HTTP/WebSocket application bytes.
        throw new Error("Unsupported upstream TLS record encoding");
      }
      const handshake =
        context.type === "ciphertext" && metadata.version === "TLS1_3"
          ? context.contentType === "HANDSHAKE"
          : header[0] === 22;
      if (handshake) {
        updateRequested =
          handshakes.inspect(content, tls.isHandshakeDone()) || updateRequested;
      }
    },
    onRecvCertificates({ certificates }) {
      try {
        validatePeerCertificates(certificates, hostname, roots);
        verified = true;
      } catch {
        failure = new Error("Upstream TLS certificate validation failed");
        throw failure;
      }
    },
    onApplicationData(data) {
      if (!verified || !tls.isHandshakeDone() || plaintext.length >= 2) {
        failure = new Error("Invalid upstream TLS application data");
        throw failure;
      }
      if (data.length) {
        plaintext.push(data);
      }
    },
    onTlsEnd(error) {
      ended = true;
      if (error) {
        failure ??= new Error("Upstream TLS connection failed");
      }
      // The response/handshake owner awaits the same idempotent socket teardown.
      void connection.close();
    },
  });
  const receive = async (): Promise<void> => {
    if (failure) {
      throw failure;
    }
    const header = await reader.readExactly(5);
    const length = (header[3] << 8) | header[4];
    if (length > 18 * 1024) {
      throw new Error("Upstream TLS record exceeds its limit");
    }
    if (!tls.isHandshakeDone()) {
      handshakeBytes += length + 5;
      if (handshakeBytes > 256 * 1024) {
        throw new Error("Upstream TLS handshake exceeds its limit");
      }
    }
    await tls.handleReceivedPacket({
      type: header[0],
      packet: { header, content: await reader.readExactly(length) },
    });
    if (failure) {
      throw failure;
    }
    if (updateRequested && !keyUpdateQueued) {
      // Receive-side processing must not wait on a blocked upload. Put control
      // writes on the send queue; active uploads also check between records.
      keyUpdateQueued = true;
      writes = writes
        .then(async () => {
          try {
            do {
              await sendKeyUpdate();
            } while (updateRequested && !ended && !closing);
          } finally {
            keyUpdateQueued = false;
          }
        })
        .catch(async () => {
          failure ??= new Error("Upstream TLS key update failed");
          await close();
        });
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await connection.close();
      // Ending an already failed TLS session must not replace its original error.
      await tls.end().catch(() => {});
    })();
    return closing;
  };
  async function sendKeyUpdate(): Promise<void> {
    if (!updateRequested || ended || closing) {
      return;
    }
    updateRequested = false;
    await tls.updateTrafficKeys(false);
  }
  try {
    await tls.startHandshake();
    while (!tls.isHandshakeDone()) {
      if (ended) {
        throw new Error("Upstream TLS handshake ended early");
      }
      await receive();
    }
    const metadata = tls.getMetadata();
    if (
      !verified ||
      !metadata.cipherSuite ||
      !CIPHER_SUITES.includes(metadata.cipherSuite) ||
      (metadata.selectedAlpn && metadata.selectedAlpn !== "http/1.1")
    ) {
      throw new Error("Unsupported upstream TLS negotiation");
    }
  } catch {
    await close();
    throw failure ?? new Error("Upstream TLS handshake failed");
  }
  // Serialize send-side state while allowing receives to unblock early HTTP responses.
  return {
    writeChunkBytes: MAX_ENC_PACKET_SIZE,
    async read() {
      try {
        for (;;) {
          if (failure) {
            throw failure;
          }
          const next = plaintext.shift();
          if (next) {
            return next;
          }
          if (ended || closing) {
            return null;
          }
          await receive();
        }
      } catch {
        await close();
        throw failure ?? new Error("Upstream TLS stream ended unexpectedly");
      }
    },
    write(data) {
      const next = writes.then(async () => {
        if (closing || ended || failure) {
          throw failure ?? new Error("Upstream TLS connection is closed");
        }
        // Passing a whole large message to tls.write() makes the library copy
        // every TLS record up front. Feed one record at a time instead.
        // Its 16,380-byte limit is below 16 KiB; larger chunks leave tiny records.
        for (
          let offset = 0;
          offset < data.length;
          offset += MAX_ENC_PACKET_SIZE
        ) {
          await sendKeyUpdate();
          await tls.write(data.subarray(offset, offset + MAX_ENC_PACKET_SIZE));
        }
      });
      writes = next.catch(async () => {
        failure ??= new Error("Upstream TLS write failed");
        await close();
      });
      return next;
    },
    close,
  };
}
