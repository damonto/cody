const MAX_HANDSHAKE_MESSAGE_BYTES = 256 * 1024;
const SESSION_TICKET = 4;
const KEY_UPDATE = 24;

/** Bound the TLS library's plaintext handshake buffer, including after establishment. */
export class TlsHandshakeReader {
  private readonly header = new Uint8Array(4);
  private headerSize = 0;
  private messageType = 0;
  private remaining = 0;

  /** Returns true when a complete TLS 1.3 KeyUpdate requests a reciprocal update. */
  inspect(data: Uint8Array, established: boolean): boolean {
    let offset = 0;
    let updateRequested = false;
    while (offset < data.length) {
      if (this.remaining === 0) {
        while (this.headerSize < 4 && offset < data.length) {
          this.header[this.headerSize++] = data[offset++];
        }
        if (this.headerSize < 4) {
          break;
        }
        this.messageType = this.header[0];
        this.remaining =
          (this.header[1] << 16) | (this.header[2] << 8) | this.header[3];
        this.headerSize = 0;
        if (this.remaining > MAX_HANDSHAKE_MESSAGE_BYTES) {
          throw new Error("Upstream TLS handshake message exceeds its limit");
        }
        if (
          established &&
          this.messageType !== SESSION_TICKET &&
          this.messageType !== KEY_UPDATE
        ) {
          throw new Error("Unsupported upstream TLS post-handshake message");
        }
        if (
          this.messageType === KEY_UPDATE &&
          (!established || this.remaining !== 1)
        ) {
          throw new Error("Invalid upstream TLS key update");
        }
        if (this.remaining === 0) {
          continue;
        }
      }
      if (offset === data.length) {
        break;
      }
      if (this.messageType === KEY_UPDATE) {
        if (data[offset] > 1) {
          throw new Error("Invalid upstream TLS key update");
        }
        updateRequested ||= data[offset] === 1;
      }
      const consumed = Math.min(this.remaining, data.length - offset);
      offset += consumed;
      this.remaining -= consumed;
    }
    return updateRequested;
  }
}
