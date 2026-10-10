import { MAX_OBSERVED_JSON_CHARS, SseObserver } from "./stream.ts";
import type {
  ResponseFormat,
  ResponseObservationFormat,
} from "../gateway/http/response-format.ts";

const MAX_FORMAT_PREFIX_CHARS = 1024;
const SSE_PREFIXES = [":", "data:", "event:", "id:", "retry:"];

interface ResponseObserverOptions {
  readonly format: ResponseObservationFormat;
  readonly onEvent: (
    value: unknown,
    event: string,
    format: ResponseFormat,
  ) => void;
  readonly onIssue: (issue: string, format: ResponseFormat | undefined) => void;
  readonly maxPayloadChars?: number;
  readonly onDone?: () => void;
  readonly onFirstData?: () => void;
  readonly shouldParse?: (data: string, event: string) => boolean;
}

type ObserverState =
  | { kind: "auto"; prefix: string }
  | { kind: "json"; body: string }
  | { kind: "sse"; observer: SseObserver }
  | { kind: "closed" };

/** Observe one read path, retaining only a bounded prefix when headers are absent. */
export class ResponseObserver {
  private readonly decoder = new TextDecoder();
  private readonly limit: number;
  private state: ObserverState;
  private resolvedFormat: ResponseFormat | undefined;

  constructor(private readonly options: ResponseObserverOptions) {
    this.limit = options.maxPayloadChars ?? MAX_OBSERVED_JSON_CHARS;
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0)
      throw new RangeError(
        "Response observation limit must be a positive integer",
      );
    this.state =
      options.format === "auto"
        ? { kind: "auto", prefix: "" }
        : this.createParser(options.format);
  }

  /** Retain the resolved format after ending or discarding the parser. */
  get format(): ResponseFormat | undefined {
    return this.resolvedFormat;
  }

  /** Stop observation and release all retained JSON, SSE and detection buffers. */
  discard(): void {
    this.state = { kind: "closed" };
  }

  private fail(issue: string): void {
    this.discard();
    this.options.onIssue(issue, this.format);
  }

  private createParser(format: ResponseFormat): ObserverState {
    this.resolvedFormat = format;
    if (format === "json") return { kind: "json", body: "" };
    return {
      kind: "sse",
      observer: new SseObserver({
        ...this.options,
        maxEventChars: this.limit,
        onEvent: (value, event) => this.options.onEvent(value, event, "sse"),
        onIssue: (issue) => this.options.onIssue(issue, "sse"),
      }),
    };
  }

  private text(text: string): void {
    let state = this.state;
    if (state.kind === "closed") return;
    if (state.kind === "auto") {
      const size = Math.min(
        text.length,
        MAX_FORMAT_PREFIX_CHARS - state.prefix.length,
      );
      state.prefix += text.slice(0, size);
      const candidate = state.prefix.trimStart();
      const format = candidate.startsWith("{")
        ? "json"
        : SSE_PREFIXES.some((prefix) => candidate.startsWith(prefix))
          ? "sse"
          : undefined;
      if (!format) {
        if (
          state.prefix.length === MAX_FORMAT_PREFIX_CHARS ||
          (candidate &&
            !SSE_PREFIXES.some((prefix) => prefix.startsWith(candidate)))
        )
          this.fail("unsupported_response_format");
        return;
      }
      text = state.prefix + text.slice(size);
      this.state = state = this.createParser(format);
    }
    if (state.kind === "sse") state.observer.push(text);
    else if (state.kind === "json") {
      if (state.body.length + text.length > this.limit)
        this.fail("json_body_too_large");
      else state.body += text;
    }
  }

  push(bytes: Uint8Array): void {
    if (this.state.kind !== "closed")
      this.text(this.decoder.decode(bytes, { stream: true }));
  }

  end(): void {
    if (this.state.kind === "closed") return;
    this.text(this.decoder.decode());
    const state = this.state;
    // Close before delivering callbacks so repeated or reentrant end() calls are inert.
    this.discard();
    if (state.kind === "auto") {
      this.options.onIssue("unsupported_response_format", undefined);
    } else if (state.kind === "sse") {
      state.observer.end();
    } else if (state.kind === "json") {
      let value: unknown;
      try {
        value = JSON.parse(state.body) as unknown;
      } catch {
        this.options.onIssue("invalid_response_json", "json");
        return;
      }
      this.options.onEvent(value, "", "json");
    }
  }
}
