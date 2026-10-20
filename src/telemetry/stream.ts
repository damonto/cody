import { Buffer } from "node:buffer";
import { MAX_SSE_EVENT_BYTES } from "../shared/payload-limits.ts";

const DATA_FIELD = "data:";
const DONE_MARKER = "[DONE]";

export interface SseObserverOptions {
  readonly onEvent: (value: unknown, event: string) => void;
  readonly onIssue: (issue: string) => void;
  readonly maxEventBytes?: number;
  /** Native translators may require the final event's blank-line terminator. */
  readonly requireTerminator?: boolean;
  readonly onDone?: () => void;
  readonly onFirstData?: () => void;
  /** Skip JSON parsing for events the consumer does not need; they are not delivered. */
  readonly shouldParse?: (data: string, event: string) => boolean;
}

/** A bounded SSE observer. The forwarding stream never uses decoded bytes. */
export class SseObserver {
  private buffer = "";
  private bufferBytes = 0;
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
    this.limit = options.maxEventBytes ?? MAX_SSE_EVENT_BYTES;
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) {
      throw new RangeError("SSE observation limit must be a positive integer");
    }
    // The data field prefix and its optional space are not part of the payload.
    this.lineLimit = this.limit + DATA_FIELD.length + 1;
  }

  push(text: string): void {
    if (this.skipLf && text) {
      if (text.startsWith("\n")) text = text.slice(1);
      this.skipLf = false;
    }
    // Scan only the new chunk: rescanning an accumulated image data line on
    // every push makes fragmented large events quadratic in size.
    const endings = /[\r\n]/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(text)) !== null) {
      const end = match.index;
      this.append(text.slice(start, end));
      const cr = text[end] === "\r";
      const width = cr && text[end + 1] === "\n" ? 2 : 1;
      this.skipLf = cr && end === text.length - 1;
      start = endings.lastIndex = end + width;
      const line = this.buffer;
      this.buffer = "";
      this.bufferBytes = 0;
      if (this.droppingLine) {
        this.droppingLine = false;
        this.finishDroppedLine();
        continue;
      }
      this.line(line);
    }
    this.append(text.slice(start));
  }

  private append(text: string): void {
    if (!text) return;
    if (this.droppingLine) {
      this.observeDroppedData(text);
      return;
    }
    this.buffer += text;
    this.bufferBytes += Buffer.byteLength(text, "utf8");
    if (this.bufferBytes > this.lineLimit) {
      this.droppedDataPrefix =
        !this.firstDataSeen && this.buffer.startsWith(DATA_FIELD) ? "" : null;
      this.observeDroppedData(this.buffer.slice(DATA_FIELD.length));
      this.buffer = "";
      this.bufferBytes = 0;
      this.droppingLine = true;
      this.drop();
    }
  }

  private drop(): void {
    if (this.droppingEvent) return;
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

  private finishDroppedLine(): void {
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
    this.size += Buffer.byteLength(data, "utf8") + (this.data.length ? 1 : 0);
    if (this.size > this.limit) this.drop();
    else this.data.push(data);
  }

  end(): void {
    if (
      this.options.requireTerminator &&
      (this.data.length > 0 ||
        this.event !== "" ||
        (this.buffer.trim() !== "" && !this.buffer.trimStart().startsWith(":")))
    ) {
      this.buffer = "";
      this.bufferBytes = 0;
      this.data = [];
      this.event = "";
      this.size = 0;
      this.options.onIssue("truncated_sse_event");
      return;
    }
    // Dispatch a final event even for providers that omit the trailing blank line.
    if (this.droppingLine) this.finishDroppedLine();
    else if (this.buffer) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.bufferBytes = 0;
    this.droppingLine = false;
    this.line("");
  }
}
