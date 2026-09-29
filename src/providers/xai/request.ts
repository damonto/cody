import { invalid, requestArray, validateRequest } from "./validation.ts";
import {
  findTool,
  translateToolCall,
  translateTools,
  type ToolMapping,
} from "./tools.ts";
import { object, records, text, type Wire } from "./json.ts";
import { openReasoning, reasoningText, type XaiScope } from "./replay.ts";
export type { ToolMapping } from "./tools.ts";

export interface Translation {
  body: Wire;
  tools: ToolMapping[];
}
function image(part: Wire): Wire {
  const source = object(part.source);
  const url =
    text(part.image_url) ||
    text(source.url) ||
    (source.type === "base64" &&
    text(source.media_type).startsWith("image/") &&
    text(source.data)
      ? `data:${text(source.media_type)};base64,${text(source.data)}`
      : "");
  if (!url || (!url.startsWith("data:image/") && !url.startsWith("https://")))
    invalid("xAI images require an HTTPS URL or base64 image");
  return {
    type: "input_image",
    image_url: url,
    ...(part.detail ? { detail: part.detail } : {}),
  };
}
function content(value: unknown, assistant = false): string | Wire[] {
  if (typeof value === "string") return value;
  return requestArray(value, "message content").map((part) => {
    if (["text", "input_text", "output_text"].includes(text(part.type)))
      return {
        type: assistant ? "output_text" : "input_text",
        text: text(part.text),
      };
    if (["image", "input_image"].includes(text(part.type)) && !assistant)
      return image(part);
    if (part.type === "refusal" && assistant) return part;
    return invalid(`Unsupported xAI content type: ${text(part.type)}`);
  });
}
export async function translateRequest(
  payload: Wire,
  anthropic: boolean,
  scope: XaiScope,
  key: string,
  accounts: readonly string[],
  options: { injectSearch?: boolean } = {},
): Promise<Translation> {
  validateRequest(payload, anthropic);
  if (
    payload.previous_response_id ||
    payload.background === true ||
    payload.store === true
  )
    invalid("xAI requires complete client-side conversation history");
  if (
    payload.stop ||
    (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length)
  )
    invalid("xAI Responses does not support stop sequences");
  const inject =
    options.injectSearch &&
    !records(payload.tools).some((tool) => tool.type === "x_search");
  const { definitions, mappings } = translateTools(
    payload.tools,
    anthropic,
    inject ? 1 : 0,
  );
  if (inject) definitions.push({ type: "x_search" });
  const find = (name: string, namespace?: string) =>
    findTool(mappings, name, namespace);
  const input: Wire[] = [];
  const appendMessage = (role: string, value: unknown) =>
    input.push({
      type: "message",
      role,
      content: content(value, role === "assistant"),
    });
  const call = (item: Wire, custom = false) => {
    input.push(translateToolCall(item, mappings, custom));
  };
  if (anthropic) {
    if (payload.system !== undefined) appendMessage("system", payload.system);
    for (const message of requestArray(payload.messages, "messages")) {
      const role = text(message.role);
      if (!["user", "assistant"].includes(role))
        invalid("Invalid Messages role");
      if (typeof message.content === "string") {
        appendMessage(role, message.content);
        continue;
      }
      let parts: Wire[] = [];
      const flush = () => {
        if (parts.length) {
          appendMessage(role, parts);
          parts = [];
        }
      };
      for (const part of requestArray(message.content, "content")) {
        if (part.type === "thinking") {
          flush();
          if (!part.signature)
            invalid("xAI thinking history requires its original signature");
          input.push(
            await openReasoning(
              text(part.signature),
              text(part.thinking),
              scope,
              key,
              accounts,
            ),
          );
        } else if (part.type === "redacted_thinking") {
          flush();
          input.push(
            await openReasoning(text(part.data), "", scope, key, accounts),
          );
        } else if (part.type === "tool_use") {
          flush();
          call({ ...part, arguments: part.input });
        } else if (part.type === "tool_result") {
          flush();
          let output =
            part.content === undefined
              ? ""
              : typeof part.content === "string"
                ? part.content
                : content(part.content);
          // Responses has no is_error flag; carry the failure in the tool result.
          if (part.is_error === true)
            output =
              typeof output === "string"
                ? JSON.stringify({ is_error: true, content: output })
                : [
                    { type: "input_text", text: '{"is_error":true}' },
                    ...output,
                  ];
          input.push({
            type: "function_call_output",
            call_id: part.tool_use_id,
            output,
          });
        } else parts.push(part);
      }
      flush();
    }
  } else if (typeof payload.input === "string")
    appendMessage("user", payload.input);
  else
    for (const item of requestArray(payload.input, "input")) {
      if (!item.type || item.type === "message") {
        const role = text(item.role);
        if (!["user", "assistant", "system", "developer"].includes(role))
          invalid("Invalid Responses role");
        appendMessage(role, item.content);
      } else if (item.type === "reasoning") {
        if (item.encrypted_content)
          input.push(
            await openReasoning(
              text(item.encrypted_content),
              reasoningText(item),
              scope,
              key,
              accounts,
            ),
          );
        else invalid("xAI reasoning history requires encrypted_content");
      } else if (
        item.type === "function_call" ||
        item.type === "custom_tool_call"
      )
        call(item, item.type === "custom_tool_call");
      else if (
        item.type === "function_call_output" ||
        item.type === "custom_tool_call_output"
      )
        input.push({
          type: "function_call_output",
          call_id: item.call_id,
          output: item.output,
        });
      else invalid(`Unsupported xAI input item: ${text(item.type)}`);
    }
  let choice: unknown = payload.tool_choice;
  if (typeof choice === "object" && choice !== null) {
    const value = object(choice);
    if (anthropic && ["auto", "none", "any"].includes(text(value.type)))
      choice = value.type === "any" ? "required" : value.type;
    else if (["x_search", "web_search"].includes(text(value.type))) {
      choice = "required";
      const selected = definitions.filter((tool) => tool.type === value.type);
      if (!selected.length) invalid("Forced search tool is not declared");
      definitions.splice(0, definitions.length, ...selected);
    } else if (value.type === "allowed_tools") {
      const allowed = requestArray(value.tools, "tool_choice.tools").map(
        (tool) => {
          if (["x_search", "web_search"].includes(text(tool.type))) return tool;
          const mapping = find(
            text(tool.name),
            text(tool.namespace) || undefined,
          );
          return { type: "function", name: mapping.wireName };
        },
      );
      if (
        options.injectSearch &&
        !allowed.some((tool) => tool.type === "x_search")
      )
        allowed.push({ type: "x_search" });
      choice = { ...value, tools: allowed };
    } else if (["tool", "function", "custom"].includes(text(value.type))) {
      const mapping = find(
        text(value.name),
        text(value.namespace) || undefined,
      );
      if (mapping.dispatcher)
        invalid("A folded namespace cannot force one child tool");
      choice = { type: "function", name: mapping.wireName };
    } else invalid("Unsupported xAI tool_choice");
  }
  if (
    typeof choice === "string" &&
    !["auto", "none", "required"].includes(choice)
  )
    invalid("Unsupported xAI tool_choice");
  const body: Wire = {
    model: scope.model,
    input,
    stream: true,
    store: false,
    instructions: "",
    include: [
      ...new Set([
        ...(Array.isArray(payload.include) ? payload.include : []),
        "reasoning.encrypted_content",
      ]),
    ],
    tools: definitions,
  };
  for (const field of [
    "instructions",
    "temperature",
    "top_p",
    "top_k",
    "parallel_tool_calls",
    "metadata",
    "text",
    "reasoning",
    "max_output_tokens",
  ])
    if (payload[field] !== undefined) body[field] = payload[field];
  if (choice !== undefined) body.tool_choice = choice;
  if (anthropic) {
    if (payload.max_tokens !== undefined)
      body.max_output_tokens = payload.max_tokens;
    const thinking = object(payload.thinking);
    const effort = object(payload.output_config).effort;
    if (thinking.type === "disabled") body.reasoning = { effort: "none" };
    else if (
      thinking.type === "enabled" ||
      thinking.type === "adaptive" ||
      effort
    ) {
      const budget =
        typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : 0;
      body.reasoning = {
        effort:
          effort ??
          (budget >= 16384 ? "high" : budget >= 4096 ? "medium" : "low"),
        summary: "auto",
      };
    }
    if (object(payload.tool_choice).disable_parallel_tool_use === true)
      body.parallel_tool_calls = false;
  }
  return { body, tools: mappings };
}
