export const MAX_OBSERVED_JSON_CHARS = 2 * 1024 * 1024;

/** A bounded SSE observer. The forwarding stream never uses decoded bytes. */
export class SseObserver {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private size = 0;
  private droppingLine = false;
  private droppingEvent = false;
  private skipLf = false;

  constructor(
    private readonly onEvent: (value: unknown, event: string) => void,
    private readonly onIssue: (issue: string) => void,
    private readonly limit = MAX_OBSERVED_JSON_CHARS,
    private readonly onDone?: () => void,
  ) {}

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
        continue;
      }
      this.line(line);
    }
    if (this.buffer.length > this.limit) {
      this.buffer = "";
      this.droppingLine = true;
      this.drop();
    }
  }

  private drop(): void {
    this.droppingEvent = true;
    this.data = [];
    this.size = 0;
    this.onIssue("sse_event_too_large");
  }

  private line(line: string): void {
    if (line === "") {
      if (!this.droppingEvent && this.data.length > 0) {
        const text = this.data.join("\n");
        if (text === "[DONE]") this.onDone?.();
        else {
          try {
            this.onEvent(JSON.parse(text) as unknown, this.event);
          } catch {
            this.onIssue("invalid_sse_json");
          }
        }
      }
      this.data = [];
      this.event = "";
      this.size = 0;
      this.droppingEvent = false;
      return;
    }
    if (this.droppingEvent || line.startsWith(":")) return;
    if (line.startsWith("event:"))
      this.event = line.slice(6).trim().slice(0, 160);
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).replace(/^ /, "");
    this.size += data.length + 1;
    if (this.size > this.limit) this.drop();
    else this.data.push(data);
  }

  end(): void {
    // Dispatch a final event even for providers that omit the trailing blank line.
    if (this.buffer && !this.droppingLine)
      this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.line("");
  }
}
