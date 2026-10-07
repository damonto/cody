import { ProviderRequestError } from "../errors.ts";
import type { UpstreamMetadataObserver } from "../../telemetry/inference-metadata.ts";
import { object, records, text, type Wire } from "./json.ts";
import { reasoningText, sealReasoning, type XaiScope } from "./replay.ts";
import { restoreTool, type ToolMapping } from "./tools.ts";
import { XaiSearchFilter } from "./search.ts";
export interface EncodingOptions {
  anthropic: boolean;
  stream: boolean;
  model: string;
  scope: XaiScope;
  key: string;
  tools: ToolMapping[];
  signal?: AbortSignal;
  search?: boolean;
  onCompleted?: (output: Wire[]) => Promise<void>;
  observe?: UpstreamMetadataObserver;
}
export function xaiUsage(value: unknown, anthropic: boolean): Wire {
  const usage = object(value);
  if (!anthropic) return usage;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cached =
    typeof object(usage.input_tokens_details).cached_tokens === "number"
      ? Number(object(usage.input_tokens_details).cached_tokens)
      : 0;
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}
interface Item {
  native: Wire;
  final?: Wire;
  arguments: string;
  thinking: string;
  text: string;
  closed: boolean;
  block?: number;
  started?: boolean;
  partStarted?: boolean;
  refusal?: boolean;
  textDone?: string;
  thinkingDone?: string;
  partIndex?: number;
}
export class ResponseEncoder {
  private readonly items = new Map<number, Item>();
  private readonly upstreamIndexes = new Map<number, number>();
  private readonly searchFilter = new XaiSearchFilter();
  private metadata: Wire = {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
  };
  private sequence = 0;
  private block = 0;
  private started = false;
  private bytes = 0;
  private output: Wire[] = [];
  terminal = false;
  result: Wire | undefined;
  constructor(private readonly options: EncodingOptions) {}
  private event(type: string, data: Wire = {}): Wire {
    return {
      ...data,
      type,
      ...(!this.options.anthropic ? { sequence_number: this.sequence++ } : {}),
    };
  }
  private start(): Wire[] {
    if (this.started) return [];
    this.started = true;
    if (!this.options.anthropic)
      return [
        this.event("response.created", {
          response: {
            ...this.metadata,
            model: this.options.model,
            status: "in_progress",
            output: [],
          },
        }),
        this.event("response.in_progress", {
          response: { ...this.metadata, status: "in_progress", output: [] },
        }),
      ];
    return [
      this.event("message_start", {
        message: {
          id: this.metadata.id,
          type: "message",
          role: "assistant",
          model: this.options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }
  private ensure(index: number, native: Wire = {}): Item {
    if (!Number.isInteger(index) || index < 0 || index >= 1024)
      throw new ProviderRequestError("Invalid xAI output index", 502);
    let item = this.items.get(index);
    if (!item) {
      item = { native, arguments: "", thinking: "", text: "", closed: false };
      this.items.set(index, item);
    } else item.native = { ...item.native, ...native };
    return item;
  }
  private mapping(item: Wire): ToolMapping | undefined {
    return this.options.tools.find((tool) => tool.wireName === item.name);
  }
  private outputIndex(event: Wire): number {
    const native = object(event.item);
    const id = text(native.id) || text(native.call_id) || text(event.item_id);
    const byId = id
      ? [...this.items].find(([, item]) => item.native.id === id)?.[0]
      : undefined;
    const upstream =
      typeof event.output_index === "number" ? event.output_index : undefined;
    let index =
      byId ??
      (upstream === undefined ? undefined : this.upstreamIndexes.get(upstream));
    if (
      index === undefined &&
      (!event.item || (!id && event.type !== "response.output_item.added"))
    ) {
      const open = [...this.items].filter(([, item]) => !item.closed);
      if (open.length === 1) index = open[0]?.[0];
    }
    index ??= this.items.size;
    if (upstream !== undefined) this.upstreamIndexes.set(upstream, index);
    this.ensure(index, { ...(id ? { id } : {}), ...native });
    return index;
  }
  private openItem(index: number, item: Item): Wire[] {
    if (item.started) return [];
    const native = item.native;
    const mapping = this.mapping(native);
    if (
      native.type === "function_call" &&
      (!mapping || mapping.custom || mapping.dispatcher)
    )
      return [];
    item.started = true;
    return [
      this.event("response.output_item.added", {
        output_index: index,
        item: {
          ...native,
          status: "in_progress",
          encrypted_content: undefined,
          ...(native.type === "reasoning"
            ? { summary: [], content: undefined }
            : {}),
          ...(native.type === "message" ? { content: [] } : {}),
          ...(mapping
            ? {
                name: mapping.name,
                arguments: "",
                ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
              }
            : {}),
        },
      }),
    ];
  }
  private openPart(index: number, item: Item, thinking: boolean): Wire[] {
    const events = this.openItem(index, item);
    if (item.partStarted) return events;
    item.partStarted = true;
    events.push(
      this.event(
        thinking
          ? "response.reasoning_summary_part.added"
          : "response.content_part.added",
        {
          output_index: index,
          item_id: item.native.id,
          ...(thinking
            ? {
                summary_index: item.partIndex ?? 0,
                part: { type: "summary_text", text: "" },
              }
            : {
                content_index: item.partIndex ?? 0,
                part: item.refusal
                  ? { type: "refusal", refusal: "" }
                  : { type: "output_text", text: "", annotations: [] },
              }),
        },
      ),
    );
    return events;
  }
  private async finishItem(
    index: number,
    item: Item,
    terminal = false,
  ): Promise<Wire[]> {
    if (item.closed) return [];
    if (
      !terminal &&
      item.native.type === "reasoning" &&
      !item.native.encrypted_content
    )
      return [];
    item.closed = true;
    let native = item.native;
    if (records(native.content)[0]?.type === "refusal") item.refusal = true;
    if (native.type === "reasoning") {
      const summary = records(native.summary);
      const content = records(native.content).filter(
        (part) => part.type === "reasoning_text",
      );
      const visible = content.length
        ? content.map((part) => text(part.text)).join("")
        : (summary.length ? reasoningText(native) : "") ||
          item.thinkingDone ||
          item.thinking;
      native = {
        ...native,
        content: undefined,
        summary: visible ? [{ type: "summary_text", text: visible }] : [],
      };
      if (
        typeof native.encrypted_content === "string" &&
        native.encrypted_content
      )
        item.final = {
          ...native,
          encrypted_content: await sealReasoning(
            item.native,
            visible,
            this.options.scope,
            this.options.key,
          ),
        };
      else if (visible)
        throw new ProviderRequestError(
          "xAI reasoning is missing replay content",
          502,
        );
      else item.final = native;
    } else if (native.type === "function_call")
      item.final = restoreTool(
        {
          ...native,
          arguments: native.arguments || item.arguments,
        },
        this.options.tools,
      );
    else if (native.type === "message")
      item.final = {
        ...native,
        content: records(native.content).length
          ? native.content
          : [
              item.refusal
                ? { type: "refusal", refusal: item.textDone ?? item.text }
                : {
                    type: "output_text",
                    text: item.textDone ?? item.text,
                    annotations: [],
                  },
            ],
      };
    else if (
      native.type === "web_search_call" ||
      native.type === "x_search_call"
    )
      item.final = native;
    else
      throw new ProviderRequestError(
        `Unsupported xAI output item: ${text(native.type)}`,
        502,
      );
    const result = item.final;
    if (!this.options.anthropic) {
      const events: Wire[] = this.openItem(index, item);
      if (native.type === "message" || native.type === "reasoning") {
        const thinking = native.type === "reasoning";
        events.push(...this.openPart(index, item, thinking));
        const visible = thinking
          ? reasoningText(result)
          : records(result.content)
              .map((part) => text(part.text) || text(part.refusal))
              .join("");
        const sent = thinking ? item.thinking : item.text;
        if (!visible.startsWith(sent))
          throw new ProviderRequestError("xAI changed streamed content", 502);
        const fields = {
          output_index: index,
          item_id: result.id,
          ...(thinking
            ? { summary_index: item.partIndex ?? 0 }
            : { content_index: item.partIndex ?? 0 }),
        };
        if (visible.length > sent.length)
          events.push(
            this.event(
              thinking
                ? "response.reasoning_summary_text.delta"
                : item.refusal
                  ? "response.refusal.delta"
                  : "response.output_text.delta",
              { ...fields, delta: visible.slice(sent.length) },
            ),
          );
        events.push(
          this.event(
            thinking
              ? "response.reasoning_summary_text.done"
              : item.refusal
                ? "response.refusal.done"
                : "response.output_text.done",
            {
              ...fields,
              ...(item.refusal ? { refusal: visible } : { text: visible }),
            },
          ),
        );
        events.push(
          this.event(
            thinking
              ? "response.reasoning_summary_part.done"
              : "response.content_part.done",
            {
              ...fields,
              part: thinking
                ? { type: "summary_text", text: visible }
                : item.refusal
                  ? { type: "refusal", refusal: visible }
                  : {
                      type: "output_text",
                      text: visible,
                      annotations:
                        records(result.content)[0]?.annotations ?? [],
                    },
            },
          ),
        );
      }
      if (
        native.type === "function_call" &&
        (this.mapping(native)?.custom || this.mapping(native)?.dispatcher)
      ) {
        events.push(
          this.event("response.output_item.added", {
            output_index: index,
            item: {
              ...result,
              arguments: "",
              input: result.type === "custom_tool_call" ? "" : undefined,
            },
          }),
        );
        const custom = result.type === "custom_tool_call";
        events.push(
          this.event(
            custom
              ? "response.custom_tool_call_input.delta"
              : "response.function_call_arguments.delta",
            {
              output_index: index,
              item_id: result.id,
              delta: custom ? result.input : result.arguments,
            },
          ),
        );
        events.push(
          this.event(
            custom
              ? "response.custom_tool_call_input.done"
              : "response.function_call_arguments.done",
            {
              output_index: index,
              item_id: result.id,
              ...(custom
                ? { input: result.input }
                : { arguments: result.arguments }),
            },
          ),
        );
      } else if (native.type === "function_call") {
        const args = text(result.arguments);
        if (!args.startsWith(item.arguments))
          throw new ProviderRequestError("xAI changed tool arguments", 502);
        if (args.length > item.arguments.length)
          events.push(
            this.event("response.function_call_arguments.delta", {
              output_index: index,
              item_id: result.id,
              delta: args.slice(item.arguments.length),
            }),
          );
        events.push(
          this.event("response.function_call_arguments.done", {
            output_index: index,
            item_id: result.id,
            arguments: args,
          }),
        );
      }
      events.push(
        this.event("response.output_item.done", {
          output_index: index,
          item: result,
        }),
      );
      return events;
    }
    const events: Wire[] = [];
    if (native.type === "function_call") {
      const block = this.block++;
      let args: unknown;
      try {
        args =
          result.type === "custom_tool_call"
            ? { input: result.input }
            : JSON.parse(text(result.arguments));
      } catch {
        throw new ProviderRequestError("Invalid xAI tool arguments", 502);
      }
      const value = {
        type: "tool_use",
        id: result.call_id,
        name: result.name,
        input: args,
      };
      this.output.push(value);
      events.push(
        this.event("content_block_start", {
          index: block,
          content_block: { ...value, input: {} },
        }),
        this.event("content_block_delta", {
          index: block,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(args),
          },
        }),
        this.event("content_block_stop", { index: block }),
      );
      return events;
    }
    const thinking = native.type === "reasoning";
    const visible = thinking
      ? reasoningText(result)
      : records(result.content)
          .map((part) => text(part.text) || text(part.refusal))
          .join("");
    if (item.block === undefined) {
      item.block = this.block++;
      events.push(
        this.event("content_block_start", {
          index: item.block,
          content_block: thinking
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" },
        }),
      );
    }
    const sent = thinking ? item.thinking : item.text;
    if (visible !== sent) {
      if (!visible.startsWith(sent))
        throw new ProviderRequestError("xAI changed streamed content", 502);
      events.push(
        this.event("content_block_delta", {
          index: item.block,
          delta: thinking
            ? { type: "thinking_delta", thinking: visible.slice(sent.length) }
            : { type: "text_delta", text: visible.slice(sent.length) },
        }),
      );
    }
    if (thinking && result.encrypted_content)
      events.push(
        this.event("content_block_delta", {
          index: item.block,
          delta: {
            type: "signature_delta",
            signature: result.encrypted_content,
          },
        }),
      );
    events.push(this.event("content_block_stop", { index: item.block }));
    this.output.push(
      thinking
        ? {
            type: "thinking",
            thinking: visible,
            signature: result.encrypted_content ?? "",
          }
        : { type: "text", text: visible },
    );
    return events;
  }
  async accept(event: Wire): Promise<Wire[]> {
    if (this.terminal) return [];
    if (this.options.search) {
      const filtered = this.searchFilter.apply(event, this.options.anthropic);
      if (!filtered) return [];
      event = filtered;
    }
    this.bytes += JSON.stringify(event).length;
    if (this.bytes > 32 * 1024 * 1024)
      throw new ProviderRequestError("xAI output exceeds limit", 502);
    const type = text(event.type);
    if (type === "error" || type === "response.failed") {
      this.terminal = true;
      this.result = {
        ...object(event.response),
        model: this.options.model,
        output: [...this.items.values()].flatMap((item) =>
          item.final ? [item.final] : [],
        ),
        status: "failed",
        error: object(event.error ?? object(event.response).error),
      };
      return [
        ...this.start(),
        this.options.anthropic
          ? this.event("error", {
              error: { type: "api_error", message: "xAI inference failed" },
            })
          : this.event("response.failed", {
              response: { ...this.metadata, ...this.result },
            }),
      ];
    }
    if (type === "response.created" || type === "response.in_progress") {
      this.metadata = {
        ...this.metadata,
        ...object(event.response),
        model: this.options.model,
      };
      return this.start();
    }
    const events = this.start();
    if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event.response);
      const finalOutput = records(response.output);
      for (let i = 0; i < finalOutput.length; i++)
        this.outputIndex({ item: finalOutput[i], output_index: i });
      for (const [index, item] of [...this.items].sort(([a], [b]) => a - b))
        events.push(...(await this.finishItem(index, item, true)));
      this.terminal = true;
      if (type === "response.completed")
        await this.options.onCompleted?.(
          [...this.items.values()].flatMap((item) =>
            item.final ? [item.final] : [],
          ),
        );
      if (this.options.anthropic) {
        const stop =
          type === "response.incomplete"
            ? object(response.incomplete_details).reason === "max_output_tokens"
              ? "max_tokens"
              : "pause_turn"
            : this.output.some((part) => part.type === "tool_use")
              ? "tool_use"
              : "end_turn";
        this.result = {
          id: this.metadata.id,
          type: "message",
          role: "assistant",
          model: this.options.model,
          content: this.output,
          stop_reason: stop,
          stop_sequence: null,
          usage: xaiUsage(response.usage, true),
        };
        events.push(
          this.event("message_delta", {
            delta: { stop_reason: stop, stop_sequence: null },
            usage: xaiUsage(response.usage, true),
          }),
          this.event("message_stop"),
        );
      } else {
        this.result = {
          ...this.metadata,
          ...response,
          model: this.options.model,
          object: "response",
          status: type === "response.incomplete" ? "incomplete" : "completed",
          output: [...this.items]
            .sort(([a], [b]) => a - b)
            .map(([, item]) => item.final),
          usage: xaiUsage(response.usage, false),
        };
        events.push(this.event(type, { response: this.result }));
      }
      return events;
    }
    if (type === "response.output_item.added") {
      const index = this.outputIndex(event);
      const item = this.ensure(index, object(event.item));
      if (!this.options.anthropic) {
        if (item.native.type === "function_call" && !this.mapping(item.native))
          throw new ProviderRequestError(
            "xAI returned an undeclared tool",
            502,
          );
        events.push(...this.openItem(index, item));
      }
      return events;
    }
    if (type === "response.output_item.done") {
      const index = this.outputIndex(event);
      events.push(
        ...(await this.finishItem(
          index,
          this.ensure(index, object(event.item)),
        )),
      );
      return events;
    }
    if (
      ![
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.reasoning_text.delta",
        "response.reasoning_summary_text.delta",
        "response.reasoning_text.done",
        "response.reasoning_summary_text.done",
        "response.content_part.done",
        "response.reasoning_summary_part.done",
        "response.output_text.done",
        "response.refusal.done",
        "response.output_text.delta",
        "response.refusal.delta",
      ].includes(type)
    )
      return events;
    const index = this.outputIndex(event);
    const item = this.ensure(index);
    item.partIndex ??=
      typeof event.summary_index === "number"
        ? event.summary_index
        : typeof event.content_index === "number"
          ? event.content_index
          : 0;
    if (
      type === "response.content_part.done" ||
      type === "response.reasoning_summary_part.done"
    ) {
      const part = object(event.part);
      if (part.type === "reasoning_text" || part.type === "summary_text")
        item.thinkingDone = text(part.text);
      else {
        item.textDone = text(part.text) || text(part.refusal);
        if (part.type === "refusal") item.refusal = true;
      }
      return events;
    }
    if (
      type === "response.reasoning_text.done" ||
      type === "response.reasoning_summary_text.done"
    ) {
      item.thinkingDone = text(event.text);
      return events;
    }
    if (
      type === "response.output_text.done" ||
      type === "response.refusal.done"
    ) {
      item.textDone = text(event.text) || text(event.refusal);
      return events;
    }
    if (type === "response.refusal.delta") item.refusal = true;
    if (type === "response.function_call_arguments.delta")
      item.arguments += text(event.delta);
    if (type === "response.function_call_arguments.done")
      item.native.arguments = event.arguments;
    const thinking =
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta";
    const outputText =
      type === "response.output_text.delta" ||
      type === "response.refusal.delta";
    if (!this.options.anthropic && (thinking || outputText))
      events.push(...this.openPart(index, item, thinking));
    if (thinking) item.thinking += text(event.delta);
    if (outputText) item.text += text(event.delta);
    if (this.options.anthropic) {
      if (thinking || outputText) {
        if (item.block === undefined) {
          item.block = this.block++;
          events.push(
            this.event("content_block_start", {
              index: item.block,
              content_block: thinking
                ? { type: "thinking", thinking: "", signature: "" }
                : { type: "text", text: "" },
            }),
          );
        }
        events.push(
          this.event("content_block_delta", {
            index: item.block,
            delta: thinking
              ? { type: "thinking_delta", thinking: event.delta }
              : { type: "text_delta", text: event.delta },
          }),
        );
      }
    } else if (
      !type.endsWith(".done") &&
      !type.startsWith("response.content_part.") &&
      !type.startsWith("response.reasoning_summary_part.") &&
      !(
        type.startsWith("response.function_call_arguments.") &&
        (this.mapping(item.native)?.custom ||
          this.mapping(item.native)?.dispatcher)
      )
    ) {
      const normalized = type.replace(
        "response.reasoning_text.",
        "response.reasoning_summary_text.",
      );
      events.push(
        this.event(normalized, {
          ...event,
          output_index: index,
          ...(thinking
            ? { summary_index: item.partIndex, content_index: undefined }
            : {}),
        }),
      );
    }
    return events;
  }
}
