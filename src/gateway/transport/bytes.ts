export interface Connection {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** Idempotent teardown; resolves after pending I/O and stream locks are released. */
  close(): Promise<void>;
}

export const STREAM_CHUNK_BYTES = 16 * 1024;

export function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** One bounded lookahead buffer, shared across protocol upgrades. */
export class ByteReader {
  private buffer: Uint8Array = new Uint8Array();
  private offset = 0;

  constructor(private readonly read: () => Promise<Uint8Array | null>) {}

  private async fill(): Promise<boolean> {
    while (this.offset === this.buffer.length) {
      const next = await this.read();
      if (next === null) {
        this.buffer = new Uint8Array();
        this.offset = 0;
        return false;
      }
      this.buffer = next;
      this.offset = 0;
    }
    return true;
  }

  async readSome(limit = STREAM_CHUNK_BYTES): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("Read limit must be a positive safe integer");
    }
    if (!(await this.fill())) {
      return null;
    }
    const end = Math.min(this.buffer.length, this.offset + limit);
    const result = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return result;
  }

  async readExactly(size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("Read size must be a non-negative safe integer");
    }
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const part = await this.readSome(size - offset);
      if (part === null) {
        throw new Error("Unexpected end of upstream stream");
      }
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  async readLine(limit: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (await this.fill()) {
      const newline = this.buffer.indexOf(10, this.offset);
      const end = newline === -1 ? this.buffer.length : newline + 1;
      const part = this.buffer.subarray(this.offset, end);
      size += part.length;
      if (size > limit) {
        throw new Error("Upstream HTTP line exceeds its limit");
      }
      parts.push(part);
      this.offset = end;
      if (newline !== -1) {
        const line = concatenate(parts);
        if (line.length < 2 || line[line.length - 2] !== 13) {
          throw new Error("Invalid upstream HTTP line ending");
        }
        return line;
      }
    }
    throw new Error("Unexpected end of upstream HTTP headers");
  }
}
