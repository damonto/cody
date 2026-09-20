import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import { anthropicErrorType, apiError } from "../../gateway/http/http.ts";
import type { ApiProtocol } from "../../gateway/protocol.ts";
import { SseObserver } from "../../telemetry/stream.ts";
import { ProviderRequestError } from "../errors.ts";
import { object } from "./api.ts";
import {
  partSchema,
  sealPart,
  type NativePart,
  type ReplayScope,
} from "./replay.ts";
import { wireTool, type ToolMapping } from "./request.ts";

type Wire = Record<string, unknown>;
const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(partSchema) }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z.record(z.string(), z.unknown()).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});
export function translatedUsage(
  value: unknown,
  protocol: ApiProtocol,
): Wire | undefined {
  const metadata = object(object(value).response ?? value).usageMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const input = object(metadata);
  const count = (name: string) =>
    typeof input[name] === "number" &&
    Number.isSafeInteger(input[name]) &&
    input[name] >= 0
      ? input[name]
      : undefined;
  const prompt = count("promptTokenCount");
  const cached = count("cachedContentTokenCount") ?? 0;
  const thought = count("thoughtsTokenCount") ?? 0;
  const generated = count("candidatesTokenCount");
  if (prompt === undefined && generated === undefined) return undefined;
  const output = generated === undefined ? undefined : generated + thought;
  return protocol === "anthropic"
    ? {
        ...(prompt === undefined
          ? {}
          : { input_tokens: Math.max(0, prompt - cached) }),
        cache_read_input_tokens: cached,
        // GenerateContent has no explicit cache-creation operation in this adapter.
        cache_creation_input_tokens: 0,
        ...(output === undefined ? {} : { output_tokens: output }),
        reasoning_tokens: thought,
      }
    : {
        ...(prompt === undefined ? {} : { input_tokens: prompt }),
        input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
        ...(output === undefined ? {} : { output_tokens: output }),
        output_tokens_details: { reasoning_tokens: thought },
        ...(prompt === undefined || output === undefined
          ? {}
          : { total_tokens: prompt + output }),
      };
}
interface EncodingOptions {
  protocol: ApiProtocol;
  model: string;
  scope: ReplayScope;
  key: string;
  tools: ToolMapping[];
  stream: boolean;
  request?: Readonly<Record<string, unknown>>;
}
interface ActivePart {
  part: NativePart;
  index: number;
  id: string;
  callId: string;
  wire: Wire;
  kind: "text" | "thinking" | "tool";
  custom: boolean;
}

/** Request-local encoder. Only bounded final output and the current SSE frame are retained. */
class ResponseEncoder {
  private active: ActivePart | null = null;
  private output: Wire[] = [];
  private events: string[] = [];
  private sequence = 0;
  private started = false;
  private nativeBytes = 0;
  private lastClosed: Pick<ActivePart, "part" | "callId"> | undefined;
  private usageMetadata: Wire = {};
  private usage: Wire | undefined;
  private finishReason: string | undefined;
  private hasTools = false;
  readonly id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  private readonly created = Math.floor(Date.now() / 1000);
  constructor(private readonly options: EncodingOptions) {}
  private event(type: string, data: Wire) {
    if (!this.options.stream) return;
    const event = {
      ...data,
      type,
      ...(this.options.protocol === "openai"
        ? { sequence_number: this.sequence++ }
        : {}),
    };
    this.events.push(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  drain(): string[] {
    const events = this.events;
    this.events = [];
    return events;
  }
  result(status = "completed"): Wire {
    if (this.options.protocol === "anthropic")
      return {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.options.model,
        content: this.output,
        stop_reason:
          this.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : this.hasTools
              ? "tool_use"
              : "end_turn",
        stop_sequence: null,
        ...(this.usage ? { usage: this.usage } : {}),
      };
    return {
      id: this.id,
      object: "response",
      created_at: this.created,
      model: this.options.model,
      status,
      output: this.output,
      error: null,
      store: false,
      background: false,
      instructions: this.options.request?.instructions ?? null,
      max_output_tokens: this.options.request?.max_output_tokens ?? null,
      parallel_tool_calls: this.options.request?.parallel_tool_calls !== false,
      previous_response_id: null,
      reasoning: this.options.request?.reasoning ?? null,
      temperature: this.options.request?.temperature ?? null,
      top_p: this.options.request?.top_p ?? null,
      tools: this.options.request?.tools ?? [],
      tool_choice: this.options.request?.tool_choice ?? "auto",
      truncation: "disabled",
      metadata: object(this.options.request?.metadata),
      incomplete_details:
        this.finishReason === "MAX_TOKENS"
          ? { reason: "max_output_tokens" }
          : null,
      usage: this.usage ?? null,
    };
  }
  private start() {
    if (this.started) return;
    this.started = true;
    if (this.options.protocol === "openai") {
      this.event("response.created", { response: this.result("in_progress") });
      this.event("response.in_progress", {
        response: this.result("in_progress"),
      });
    } else
      this.event("message_start", {
        message: {
          ...this.result(),
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, ...this.usage },
        },
      });
  }
  private begin(part: NativePart) {
    if (this.output.length >= 1024)
      throw new ProviderRequestError(
        "Antigravity returned too many output items",
        502,
      );
    const index = this.output.length;
    const kind = part.functionCall
      ? "tool"
      : part.thought
        ? "thinking"
        : "text";
    const id = `${kind === "tool" ? "fc" : kind === "thinking" ? "rs" : "msg"}_${crypto.randomUUID().replaceAll("-", "")}`;
    const callId =
      part.functionCall?.id ||
      `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const mapping = part.functionCall
      ? wireTool(this.options.tools, part.functionCall.name)
      : undefined;
    const custom = mapping?.custom ?? false;
    let wire: Wire;
    if (this.options.protocol === "anthropic")
      wire =
        kind === "tool"
          ? {
              type: "tool_use",
              id: callId,
              name: mapping?.name ?? part.functionCall!.name,
              input: {},
            }
          : kind === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" };
    else
      wire =
        kind === "tool"
          ? {
              id,
              type: custom ? "custom_tool_call" : "function_call",
              status: "in_progress",
              call_id: callId,
              name: mapping?.name ?? part.functionCall!.name,
              ...(mapping?.namespace ? { namespace: mapping.namespace } : {}),
              ...(custom ? { input: "" } : { arguments: "" }),
            }
          : kind === "thinking"
            ? {
                id,
                type: "reasoning",
                summary: [{ type: "summary_text", text: "" }],
              }
            : {
                id,
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [{ type: "output_text", text: "", annotations: [] }],
              };
    this.active = {
      part: { ...part, ...(part.text !== undefined ? { text: "" } : {}) },
      index,
      id,
      callId,
      wire,
      kind,
      custom,
    };
    this.output.push(wire);
    if (kind === "tool") this.hasTools = true;
    if (this.options.protocol === "anthropic")
      this.event("content_block_start", { index, content_block: wire });
    else {
      this.event("response.output_item.added", {
        output_index: index,
        item: wire,
      });
      if (kind === "text")
        this.event("response.content_part.added", {
          item_id: id,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      if (kind === "thinking")
        this.event("response.reasoning_summary_part.added", {
          item_id: id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
    }
  }
  private async close() {
    const active = this.active;
    if (!active) return;
    const { part, kind, wire, id, index, custom } = active;
    const text = part.text ?? "";
    if (kind === "tool") {
      const args = part.functionCall!.args ?? {};
      const input = custom ? object(args).input : JSON.stringify(args);
      if (typeof input !== "string")
        throw new ProviderRequestError(
          "Antigravity returned invalid custom tool arguments",
          502,
        );
      if (this.options.protocol === "anthropic") {
        wire.input = args;
        this.event("content_block_delta", {
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(args),
          },
        });
      } else {
        wire[custom ? "input" : "arguments"] = input;
        const stem = custom
          ? "custom_tool_call_input"
          : "function_call_arguments";
        this.event(`response.${stem}.delta`, {
          item_id: id,
          output_index: index,
          delta: input,
        });
        this.event(`response.${stem}.done`, {
          item_id: id,
          output_index: index,
          [custom ? "input" : "arguments"]: input,
        });
      }
    } else if (kind === "thinking") {
      const signature = await sealPart(
        part,
        "self",
        this.options.scope,
        this.options.key,
      );
      if (this.options.protocol === "anthropic") {
        wire.thinking = text;
        wire.signature = signature;
        this.event("content_block_delta", {
          index,
          delta: { type: "signature_delta", signature },
        });
      } else {
        wire.summary = [{ type: "summary_text", text }];
        wire.encrypted_content = signature;
        this.event("response.reasoning_summary_text.done", {
          item_id: id,
          output_index: index,
          summary_index: 0,
          text,
        });
        this.event("response.reasoning_summary_part.done", {
          item_id: id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text },
        });
      }
    } else if (this.options.protocol === "anthropic") wire.text = text;
    else {
      wire.content = [{ type: "output_text", text, annotations: [] }];
      this.event("response.output_text.done", {
        item_id: id,
        output_index: index,
        content_index: 0,
        text,
      });
      this.event("response.content_part.done", {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
    }
    if (this.options.protocol === "anthropic")
      this.event("content_block_stop", { index });
    else {
      if (kind !== "thinking") wire.status = "completed";
      this.event("response.output_item.done", {
        output_index: index,
        item: wire,
      });
    }
    this.active = null;
    this.lastClosed = { part, callId: active.callId };
    if (kind !== "thinking" && part.thoughtSignature) {
      await this.carrier(part, active.callId);
    }
  }
  private async carrier(part: NativePart, callId?: string) {
    if (this.output.length >= 1024)
      throw new ProviderRequestError(
        "Antigravity returned too many output items",
        502,
      );
    const signature = await sealPart(
      part,
      "previous",
      this.options.scope,
      this.options.key,
      part.functionCall ? callId : undefined,
    );
    const carrierIndex = this.output.length;
    const carrier: Wire =
      this.options.protocol === "anthropic"
        ? { type: "thinking", thinking: "", signature }
        : {
            id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
            type: "reasoning",
            summary: [],
            encrypted_content: signature,
          };
    this.output.push(carrier);
    if (this.options.protocol === "anthropic") {
      this.event("content_block_start", {
        index: carrierIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      this.event("content_block_delta", {
        index: carrierIndex,
        delta: { type: "signature_delta", signature },
      });
      this.event("content_block_stop", { index: carrierIndex });
    } else {
      this.event("response.output_item.added", {
        output_index: carrierIndex,
        item: carrier,
      });
      this.event("response.output_item.done", {
        output_index: carrierIndex,
        item: carrier,
      });
    }
  }
  async accept(value: unknown, completeParts: boolean) {
    const root = object(value);
    const raw = object(root.response ?? root);
    if (root.error || raw.error) {
      const code = object(root.error ?? raw.error).code;
      throw new ProviderRequestError(
        "Antigravity reported an error during generation",
        typeof code === "number" &&
          Number.isInteger(code) &&
          code >= 400 &&
          code <= 599
          ? code
          : 502,
      );
    }
    const response = responseSchema.parse(raw);
    if (response.usageMetadata)
      this.usageMetadata = { ...this.usageMetadata, ...response.usageMetadata };
    const usage = response.usageMetadata
      ? translatedUsage(
          { usageMetadata: this.usageMetadata },
          this.options.protocol,
        )
      : undefined;
    if (usage) this.usage = usage;
    this.start();
    if (response.promptFeedback?.blockReason)
      throw new ProviderRequestError(
        `Antigravity blocked the request: ${response.promptFeedback.blockReason}`,
        400,
      );
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      this.nativeBytes += new TextEncoder().encode(
        JSON.stringify(part),
      ).byteLength;
      if (this.nativeBytes > 8 * 1024 * 1024)
        throw new ProviderRequestError(
          "Antigravity response exceeded the output limit",
          502,
        );
      if (part.text === undefined && !part.functionCall) {
        if (part.thoughtSignature && this.active) {
          this.active.part.thoughtSignature = part.thoughtSignature;
          await this.close();
        } else if (part.thoughtSignature && this.lastClosed) {
          this.lastClosed.part.thoughtSignature = part.thoughtSignature;
          await this.carrier(this.lastClosed.part, this.lastClosed.callId);
        } else if (part.thoughtSignature)
          throw new ProviderRequestError(
            "Antigravity returned a signature without associated content",
            502,
          );
        else if (part.inlineData || part.fileData)
          throw new ProviderRequestError(
            "Generated media is not supported by this endpoint",
            502,
          );
        continue;
      }
      const kind = part.functionCall
        ? "tool"
        : part.thought
          ? "thinking"
          : "text";
      if (
        this.active &&
        (kind === "tool" ||
          this.active.kind !== kind ||
          (part.thoughtSignature &&
            this.active.part.thoughtSignature &&
            part.thoughtSignature !== this.active.part.thoughtSignature))
      )
        await this.close();
      if (!this.active) this.begin(part);
      const active = this.active!;
      if (part.thoughtSignature)
        active.part.thoughtSignature = part.thoughtSignature;
      if (part.text !== undefined) {
        active.part.text = (active.part.text ?? "") + part.text;
        if (this.options.protocol === "anthropic")
          this.event("content_block_delta", {
            index: active.index,
            delta:
              kind === "thinking"
                ? { type: "thinking_delta", thinking: part.text }
                : { type: "text_delta", text: part.text },
          });
        else
          this.event(
            kind === "thinking"
              ? "response.reasoning_summary_text.delta"
              : "response.output_text.delta",
            {
              item_id: active.id,
              output_index: active.index,
              ...(kind === "thinking"
                ? { summary_index: 0 }
                : { content_index: 0 }),
              delta: part.text,
            },
          );
      }
      // A signature terminates its native part. Never append later text to signed content.
      if (completeParts || part.thoughtSignature) await this.close();
    }
  }
  async finish() {
    if (!this.started || !this.finishReason)
      throw new ProviderRequestError(
        "Antigravity stream ended before generation completed",
        502,
      );
    if (!["STOP", "MAX_TOKENS"].includes(this.finishReason))
      throw new ProviderRequestError(
        `Antigravity stopped generation: ${this.finishReason}`,
        502,
      );
    await this.close();
    if (this.options.protocol === "anthropic")
      this.event("message_delta", {
        delta: { stop_reason: this.result().stop_reason, stop_sequence: null },
        usage: this.usage ?? { output_tokens: 0 },
      });
    this.event(
      this.options.protocol === "anthropic"
        ? "message_stop"
        : this.finishReason === "MAX_TOKENS"
          ? "response.incomplete"
          : "response.completed",
      this.options.protocol === "anthropic"
        ? {}
        : {
            response: this.result(
              this.finishReason === "MAX_TOKENS" ? "incomplete" : "completed",
            ),
          },
    );
  }
  fail(error: unknown) {
    this.start();
    const message =
      error instanceof ProviderRequestError
        ? error.message
        : "Invalid or interrupted Antigravity response";
    if (this.options.protocol === "anthropic")
      this.event("error", {
        error: {
          type: anthropicErrorType(
            error instanceof ProviderRequestError ? error.status : 502,
          ),
          message,
        },
      });
    else
      this.event("response.failed", {
        response: {
          ...this.result("failed"),
          error: { code: "upstream_stream_error", message },
        },
      });
  }
}

async function* frames(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ value: unknown; complete: boolean }> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const bytes = await readBodyWithinLimit(
      response.body,
      16 * 1024 * 1024,
      response.headers.get("content-length"),
      undefined,
      signal,
    );
    yield {
      value: JSON.parse(new TextDecoder().decode(bytes)),
      complete: true,
    };
    return;
  }
  if (!response.body)
    throw new ProviderRequestError("Antigravity returned an empty stream", 502);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder();
  const pending: unknown[] = [];
  const observer = new SseObserver({
    onEvent: (value) => pending.push(value),
    onIssue: () => {
      throw new ProviderRequestError(
        "Antigravity returned an invalid SSE event",
        502,
      );
    },
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        observer.push(decoder.decode());
        observer.end();
      } else observer.push(decoder.decode(value, { stream: true }));
      while (pending.length) yield { value: pending.shift(), complete: false };
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      /* The upstream may already be closed. */
    }
    reader.releaseLock();
  }
}
export async function convertResponse(
  response: Response,
  options: EncodingOptions,
): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = apiError(
      options.protocol,
      response.status,
      `Antigravity request failed (HTTP ${response.status})`,
      {
        code: "upstream_error",
        type:
          response.status === 429
            ? "rate_limit_error"
            : response.status === 401
              ? "authentication_error"
              : response.status === 403
                ? "permission_error"
                : response.status >= 500
                  ? "server_error"
                  : "invalid_request_error",
      },
    );
    for (const header of ["retry-after", "x-request-id"]) {
      const value = response.headers.get(header);
      if (value) error.headers.set(header, value);
    }
    return error;
  }
  const encoder = new ResponseEncoder(options);
  if (!options.stream) {
    for await (const frame of frames(response))
      await encoder.accept(frame.value, frame.complete);
    await encoder.finish();
    const result = encoder.result();
    if (result.incomplete_details) result.status = "incomplete";
    return Response.json(result, { status: response.status });
  }
  const bytes = new TextEncoder();
  const cancellation = new AbortController();
  async function* encode() {
    try {
      for await (const frame of frames(response, cancellation.signal)) {
        await encoder.accept(frame.value, frame.complete);
        for (const event of encoder.drain()) yield bytes.encode(event);
      }
      await encoder.finish();
    } catch (error) {
      encoder.fail(error);
    }
    for (const event of encoder.drain()) yield bytes.encode(event);
  }
  const iterator = encode();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      cancellation.abort();
      await iterator.return();
    },
  });
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
