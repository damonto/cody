import { record } from "./usage.ts";

type Signal = "text" | "generation";

const TEXT_FIELDS = new Map([
  ["response.output_text.delta", "delta"],
  ["response.output_text.done", "text"],
  ["response.refusal.delta", "delta"],
  ["response.refusal.done", "refusal"],
  ["response.audio.transcript.delta", "delta"],
]);
const GENERATION_FIELDS = new Map([
  ["response.reasoning_text.delta", "delta"],
  ["response.reasoning_text.done", "text"],
  ["response.reasoning_summary_text.delta", "delta"],
  ["response.reasoning_summary_text.done", "text"],
  ["response.function_call_arguments.delta", "delta"],
  ["response.function_call_arguments.done", "arguments"],
  ["response.custom_tool_call_input.delta", "delta"],
  ["response.custom_tool_call_input.done", "input"],
  ["response.mcp_call_arguments.delta", "delta"],
  ["response.mcp_call_arguments.done", "arguments"],
  ["response.code_interpreter_call_code.delta", "delta"],
  ["response.code_interpreter_call_code.done", "code"],
  ["response.shell_call_command.added", "command"],
  ["response.shell_call_command.delta", "delta"],
  ["response.shell_call_command.done", "command"],
  ["response.audio.delta", "delta"],
  ["response.image_generation_call.partial_image", "partial_image_b64"],
]);

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.some(nonempty);
}

function combine(a: Signal | null, b: Signal | null): Signal | null {
  return a === "text" || b === "text" ? "text" : (a ?? b);
}

function collect(
  value: unknown,
  read: (item: unknown) => Signal | null,
): Signal | null {
  let signal: Signal | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      signal = combine(signal, read(item));
      if (signal === "text") break;
    }
  }
  return signal;
}

function contentSignal(value: unknown): Signal | null {
  const part = record(value);
  if (!part) return null;
  switch (part.type) {
    case "text":
    case "output_text":
      return nonempty(part.text) ? "text" : null;
    case "refusal":
      return nonempty(part.refusal) ? "text" : null;
    case "summary_text":
    case "reasoning_text":
      return nonempty(part.text) ? "generation" : null;
    case "thinking":
      return nonempty(part.thinking) ? "generation" : null;
    case "redacted_thinking":
      return nonempty(part.data) ? "generation" : null;
    case "compaction":
      return nonempty(part.content) ? "generation" : null;
    case "tool_use":
    case "mcp_tool_use":
    case "server_tool_use": {
      const input = record(part.input);
      return input && Object.keys(input).length > 0 ? "generation" : null;
    }
    default:
      return null;
  }
}

function outputSignal(value: unknown): Signal | null {
  const item = record(value);
  if (!item) return null;
  switch (item.type) {
    case "message":
      return item.role === undefined || item.role === "assistant"
        ? collect(item.content, contentSignal)
        : null;
    case "reasoning":
      return nonempty(item.encrypted_content) ||
        collect(item.summary, contentSignal) ||
        collect(item.content, contentSignal)
        ? "generation"
        : null;
    case "function_call":
    case "mcp_call":
    case "mcp_approval_request":
      return nonempty(item.arguments) ? "generation" : null;
    case "custom_tool_call":
      return nonempty(item.input) ? "generation" : null;
    case "code_interpreter_call":
      return nonempty(item.code) ? "generation" : null;
    case "image_generation_call":
      return nonempty(item.result) ? "generation" : null;
    case "file_search_call":
      return strings(item.queries) ? "generation" : null;
    case "web_search_call": {
      const action = record(item.action);
      return nonempty(action?.query) ||
        strings(action?.queries) ||
        nonempty(action?.url) ||
        nonempty(action?.pattern)
        ? "generation"
        : null;
    }
    case "shell_call":
      return strings(record(item.action)?.commands) ? "generation" : null;
    case "local_shell_call":
      return strings(record(item.action)?.command) ? "generation" : null;
    case "computer_call":
      return nonempty(record(item.action)?.type) ||
        (Array.isArray(item.actions) &&
          item.actions.some((action) => nonempty(record(action)?.type)))
        ? "generation"
        : null;
    case "apply_patch_call": {
      const operation = record(item.operation);
      return nonempty(operation?.path) ? "generation" : null;
    }
    default:
      return null;
  }
}

function chatSignal(value: unknown): Signal | null {
  const choice = record(value);
  const delta = record(choice?.delta) ?? record(choice?.message);
  if (!delta) return null;
  if (delta.role !== undefined && delta.role !== "assistant") return null;
  if (nonempty(delta.content) || nonempty(delta.refusal)) return "text";
  return nonempty(delta.reasoning_content) ||
    nonempty(delta.reasoning) ||
    nonempty(record(delta.function_call)?.arguments) ||
    (Array.isArray(delta.tool_calls) &&
      delta.tool_calls.some((tool) =>
        nonempty(record(record(tool)?.function)?.arguments),
      ))
    ? "generation"
    : null;
}

/** Recognize observed model content, excluding placeholders and tool results. */
export function generationSignal(
  payload: Record<string, unknown>,
  type: string,
): Signal | null {
  const textField = TEXT_FIELDS.get(type);
  if (textField) return nonempty(payload[textField]) ? "text" : null;
  const generationField = GENERATION_FIELDS.get(type);
  if (generationField)
    return nonempty(payload[generationField]) ? "generation" : null;

  switch (type) {
    case "response.output_item.added":
    case "response.output_item.done":
      return outputSignal(payload.item);
    case "response.content_part.added":
    case "response.content_part.done":
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done":
      return contentSignal(payload.part);
    case "response.completed":
    case "response.incomplete":
    case "response.failed":
      // A provider may first expose its output in a complete item. Measure
      // when that content is observed, without estimating earlier token times.
      return collect(record(payload.response)?.output, outputSignal);
    case "message_start":
      return collect(record(payload.message)?.content, contentSignal);
    case "content_block_start":
      return contentSignal(payload.content_block);
    case "content_block_delta": {
      const delta = record(payload.delta);
      switch (delta?.type) {
        case "text_delta":
          return nonempty(delta.text) ? "text" : null;
        case "thinking_delta":
          return nonempty(delta.thinking) ? "generation" : null;
        case "input_json_delta":
          return nonempty(delta.partial_json) ? "generation" : null;
        case "compaction_delta":
          return nonempty(delta.content) ? "generation" : null;
        default:
          return null;
      }
    }
    default:
      return collect(payload.choices, chatSignal);
  }
}
