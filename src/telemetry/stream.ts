export const MAX_OBSERVED_JSON_CHARS = 2 * 1024 * 1024;
const DATA_FIELD = "data:";
const DONE_MARKER = "[DONE]";

export interface SseObserverOptions {
  readonly onEvent: (value: unknown, event: string) => void;
  readonly onIssue: (issue: string) => void;
  readonly maxEventChars?: number;
  readonly onDone?: () => void;
  readonly onFirstData?: () => void;
  /** Skip JSON parsing for events the consumer does not need; they are not delivered. */
  readonly shouldParse?: (data: string, event: string) => boolean;
}

/** A bounded SSE observer. The forwarding stream never uses decoded bytes. */
export class SseObserver {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private size = 0;
  private droppingLine = false;
  private droppingEvent = false;
  private skipLf = false;
  private firstDataSeen = false;
  private droppedDataPrefix: string | null = null;
  private readonly limit: number;
  private readonly lineLimit: number;

  constructor(private readonly options: SseObserverOptions) {
    this.limit = options.maxEventChars ?? MAX_OBSERVED_JSON_CHARS;
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) {
      throw new RangeError("SSE observation limit must be a positive integer");
    }
    this.lineLimit = Math.max(this.limit, DATA_FIELD.length);
  }

  push(text: string): void {
    if (this.skipLf && text) {
      if (text.startsWith("\n")) text = text.slice(1);
      this.skipLf = false;
    }
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.search(/[\r\n]/)) >= 0) {
      const line = this.buffer.slice(0, end);
      const cr = this.buffer[end] === "\r";
      const width = cr && this.buffer[end + 1] === "\n" ? 2 : 1;
      this.skipLf = cr && end === this.buffer.length - 1;
      this.buffer = this.buffer.slice(end + width);
      if (this.droppingLine) {
        this.droppingLine = false;
        this.finishDroppedLine(line);
        continue;
      }
      this.line(line);
    }
    if (this.buffer.length > this.lineLimit) {
      if (this.droppingLine) {
        this.observeDroppedData(this.buffer);
      } else {
        this.droppedDataPrefix =
          !this.firstDataSeen && this.buffer.startsWith(DATA_FIELD) ? "" : null;
        this.observeDroppedData(this.buffer.slice(DATA_FIELD.length));
      }
      this.buffer = "";
      this.droppingLine = true;
      this.drop();
    }
  }

  private drop(): void {
    this.droppingEvent = true;
    this.data = [];
    this.size = 0;
    this.options.onIssue("sse_event_too_large");
  }

  private markFirstData(): void {
    if (this.firstDataSeen) return;
    this.firstDataSeen = true;
    this.options.onFirstData?.();
  }

  private observeFirstData(line: string): void {
    if (this.firstDataSeen || !line.startsWith(DATA_FIELD)) return;
    const data = line.slice(DATA_FIELD.length).trim();
    if (data && data !== DONE_MARKER) this.markFirstData();
  }

  private observeDroppedData(text: string): void {
    if (
      this.droppedDataPrefix === null ||
      !DONE_MARKER.startsWith(this.droppedDataPrefix)
    )
      return;
    // Retain at most seven characters to distinguish empty data and [DONE].
    // Time oversized data at the same line boundary as ordinary data.
    if (this.droppedDataPrefix === "") text = text.trimStart();
    const remaining = DONE_MARKER.length - this.droppedDataPrefix.length;
    this.droppedDataPrefix += text.slice(0, remaining);
    const tail = text.slice(remaining).trimStart();
    if (this.droppedDataPrefix === DONE_MARKER && tail)
      this.droppedDataPrefix += tail.slice(0, 1);
  }

  private finishDroppedLine(remainder: string): void {
    this.observeDroppedData(remainder);
    const data = this.droppedDataPrefix;
    this.droppedDataPrefix = null;
    if (data && data !== DONE_MARKER) this.markFirstData();
  }

  private dispatch(): void {
    const data = this.data;
    const event = this.event;
    const dropping = this.droppingEvent;
    this.data = [];
    this.event = "";
    this.size = 0;
    this.droppingEvent = false;
    if (dropping || data.length === 0) return;
    const text = data.join("\n").trim();
    if (!text) return;
    if (text === DONE_MARKER) {
      this.options.onDone?.();
      return;
    }
    if (this.options.shouldParse && !this.options.shouldParse(text, event))
      return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.options.onIssue("invalid_sse_json");
      return;
    }
    // Callback failures are observer failures, not malformed upstream JSON.
    this.options.onEvent(value, event);
  }

  private line(line: string): void {
    this.observeFirstData(line);
    if (line === "") {
      this.dispatch();
      return;
    }
    if (this.droppingEvent || line.startsWith(":")) return;
    if (line.startsWith("event:"))
      this.event = line.slice(6).trim().slice(0, 160);
    if (!line.startsWith(DATA_FIELD)) return;
    const data = line.slice(DATA_FIELD.length).replace(/^ /, "");
    this.size += data.length + 1;
    if (this.size > this.limit) this.drop();
    else this.data.push(data);
  }

  end(): void {
    // Dispatch a final event even for providers that omit the trailing blank line.
    if (this.droppingLine) this.finishDroppedLine(this.buffer);
    else if (this.buffer) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.droppingLine = false;
    this.line("");
  }
}
