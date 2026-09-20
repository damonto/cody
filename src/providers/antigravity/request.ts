import { z } from "zod";
import { ProviderRequestError } from "../errors.ts";
import { object } from "./api.ts";
import {
  openPart,
  sameVisiblePart,
  type NativePart,
  type ReplayScope,
} from "./replay.ts";

export interface NativeContent {
  role: "user" | "model";
  parts: NativePart[];
}
export interface ToolMapping {
  native: string;
  name: string;
  namespace?: string;
  custom: boolean;
  declaration: Record<string, unknown>;
}
export interface TranslatedRequest {
  request: Record<string, unknown>;
  tools: ToolMapping[];
}
const recordSchema = z.record(z.string(), z.unknown());
const string = (value: unknown, field: string): string => {
  if (typeof value !== "string")
    throw new ProviderRequestError(`${field} must be a string`);
  return value;
};
function records(value: unknown, field: string): Record<string, unknown>[] {
  const result = z.array(recordSchema).safeParse(value);
  if (!result.success)
    throw new ProviderRequestError(`${field} must be an array of objects`);
  return result.data;
}
function json(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ProviderRequestError(`${field} must contain valid JSON`);
  }
}
/** Only schema nodes are rewritten. Values in historical tool arguments remain untouched. */
export function nativeSchema(
  value: unknown,
  root: unknown = value,
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 20_000)
    throw new ProviderRequestError("Expanded tool schemas are too large");
  if (depth > 32)
    throw new ProviderRequestError(
      "Tool schema is too deeply nested or contains a recursive reference",
    );
  if (Array.isArray(value))
    return value.map((item) => nativeSchema(item, root, depth + 1, budget));
  if (value === null || typeof value !== "object") return value;
  const input = object(value);
  if (typeof input.$ref === "string") {
    if (!input.$ref.startsWith("#/"))
      throw new ProviderRequestError(
        "Only local tool schema references are supported",
      );
    let target = root;
    for (const key of input.$ref.slice(2).split("/"))
      target = object(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (target === undefined)
      throw new ProviderRequestError("Tool schema reference does not exist");
    return nativeSchema(target, root, depth + 1, budget);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      [
        "$schema",
        "$id",
        "$defs",
        "definitions",
        "title",
        "default",
        "examples",
        "$comment",
        "format",
      ].includes(key)
    )
      continue;
    if (key === "const") output.enum = [item];
    else if (key === "properties")
      output.properties = Object.fromEntries(
        Object.entries(object(item)).map(([name, schema]) => [
          name,
          nativeSchema(schema, root, depth + 1, budget),
        ]),
      );
    else if (key === "enum" || key === "required") output[key] = item;
    else output[key] = nativeSchema(item, root, depth + 1, budget);
  }
  return output;
}
async function toolsFor(value: unknown): Promise<ToolMapping[]> {
  const mappings: ToolMapping[] = [];
  const budget = { nodes: 0 };
  async function add(items: unknown, namespace?: string): Promise<void> {
    for (const tool of records(items, "tools")) {
      const type =
        tool.type === undefined ? "function" : string(tool.type, "tool type");
      if (type === "namespace") {
        await add(tool.tools, string(tool.name, "tool namespace"));
        continue;
      }
      if (type === "additional_tools") {
        await add(tool.tools, namespace);
        continue;
      }
      const custom = type === "custom";
      if (!["function", "custom"].includes(type))
        throw new ProviderRequestError(`Unsupported tool type: ${type}`);
      const definition = Object.keys(object(tool.function)).length
        ? object(tool.function)
        : tool;
      const name = string(definition.name, "tool name");
      const full = namespace ? `${namespace}.${name}` : name;
      let native = full;
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(full)) {
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(full)),
        );
        native = `cody_${full.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 35)}_${Array.from(hash.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      }
      if (mappings.some((mapping) => mapping.native === native))
        throw new ProviderRequestError(
          "Tool names must be unique within their namespace",
        );
      const parameters = custom
        ? {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          }
        : (definition.parameters ??
          definition.input_schema ?? { type: "object", properties: {} });
      mappings.push({
        native,
        name,
        ...(namespace ? { namespace } : {}),
        custom,
        declaration: {
          name: native,
          ...(typeof definition.description === "string"
            ? { description: definition.description }
            : {}),
          parametersJsonSchema: nativeSchema(parameters, parameters, 0, budget),
        },
      });
    }
  }
  await add(value ?? []);
  return mappings;
}
export function wireTool(
  mappings: ToolMapping[],
  native: string,
): ToolMapping | undefined {
  return mappings.find((mapping) => mapping.native === native);
}
function toolName(
  mappings: ToolMapping[],
  name: string,
  namespace?: string,
): string {
  return (
    mappings.find(
      (mapping) =>
        (mapping.name === name &&
          (!namespace || mapping.namespace === namespace)) ||
        `${mapping.namespace}.${mapping.name}` === name,
    )?.native ?? name
  );
}
function image(part: Record<string, unknown>): NativePart {
  const source = object(part.source);
  if (source.type === "base64")
    return {
      inlineData: {
        mimeType: string(source.media_type, "image media_type"),
        data: string(source.data, "image data"),
      },
    };
  const value =
    source.type === "url"
      ? source.url
      : typeof part.image_url === "object"
        ? object(part.image_url).url
        : part.image_url;
  const url = string(value, "image URL");
  const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (inline) return { inlineData: { mimeType: inline[1], data: inline[2] } };
  if (!url.startsWith("https://"))
    throw new ProviderRequestError(
      "Image URLs must use HTTPS or base64 data URLs",
    );
  return { fileData: { fileUri: url } };
}
export async function translateRequest(
  payload: Readonly<Record<string, unknown>>,
  endpoint: "responses" | "messages" | "messages/count_tokens",
  scope: ReplayScope,
  key: string,
  sessionId?: string,
): Promise<TranslatedRequest> {
  if (payload.previous_response_id)
    throw new ProviderRequestError(
      "Antigravity requires full conversation history; previous_response_id is unsupported",
    );
  const tools = await toolsFor(payload.tools);
  const contents: NativeContent[] = [];
  const system: NativePart[] = [];
  const calls = new Map<string, { name: string; id?: string | undefined }>();
  let current: NativeContent | undefined;
  function append(role: "user" | "model", part: NativePart) {
    if (!current || current.role !== role) {
      current = { role, parts: [] };
      contents.push(current);
    }
    current.parts.push(part);
  }
  async function replay(
    value: unknown,
    role: "user" | "model",
    visibleText?: string,
  ) {
    if (role !== "model")
      throw new ProviderRequestError(
        "Thinking signatures are only valid on assistant messages",
      );
    const decoded = await openPart(
      string(value, "thinking signature"),
      scope,
      key,
    );
    if (decoded.attachment === "previous") {
      const content = current;
      const previous =
        content?.role === "model" ? content.parts.at(-1) : undefined;
      if (!content || !previous)
        throw new ProviderRequestError(
          "Thinking signature is missing its associated content",
        );
      if (
        (visibleText !== undefined && visibleText !== "") ||
        !sameVisiblePart(decoded.part, previous) ||
        (decoded.call_id && previous.functionCall?.id !== decoded.call_id)
      )
        throw new ProviderRequestError(
          "Signed assistant content changed",
          400,
          "invalid_thinking_signature",
        );
      if (previous.functionCall?.id && decoded.part.functionCall)
        calls.set(previous.functionCall.id, {
          name: decoded.part.functionCall.name,
          id: decoded.part.functionCall.id,
        });
      content.parts[content.parts.length - 1] = decoded.part;
    } else {
      if (
        visibleText !== undefined &&
        visibleText !== (decoded.part.text ?? "")
      )
        throw new ProviderRequestError(
          "Signed thinking content changed",
          400,
          "invalid_thinking_signature",
        );
      append("model", decoded.part);
    }
  }
  async function blocks(
    value: unknown,
    role: "user" | "model",
    systemMessage = false,
  ): Promise<void> {
    if (typeof value === "string") {
      if (systemMessage) system.push({ text: value });
      else append(role, { text: value });
      return;
    }
    for (const block of records(value, "message content")) {
      const type = string(block.type, "content type");
      if (
        systemMessage &&
        !["text", "input_text", "output_text"].includes(type)
      )
        throw new ProviderRequestError(
          "System instructions must contain text only",
        );
      if (["text", "input_text", "output_text"].includes(type)) {
        const part = { text: string(block.text, "text") };
        if (systemMessage) system.push(part);
        else append(role, part);
      } else if (["image", "input_image", "image_url"].includes(type))
        append(role, image(block));
      else if (type === "thinking") {
        if (block.signature)
          await replay(
            block.signature,
            role,
            string(block.thinking ?? "", "thinking text"),
          );
        else if (typeof block.thinking === "string" && block.thinking)
          throw new ProviderRequestError(
            "Antigravity thinking history requires its original signature",
          );
      } else if (type === "tool_use") {
        if (role !== "model")
          throw new ProviderRequestError(
            "Tool calls must be assistant messages",
          );
        const id = string(block.id, "tool id");
        const name = toolName(tools, string(block.name, "tool name"));
        calls.set(id, { name, id });
        append("model", {
          functionCall: { name, args: block.input ?? {}, id },
        });
      } else if (type === "tool_result") {
        if (role !== "user")
          throw new ProviderRequestError("Tool results must be user messages");
        const id = string(block.tool_use_id, "tool result id");
        const call = calls.get(id);
        if (!call)
          throw new ProviderRequestError(
            `Tool result has no matching call: ${id}`,
          );
        append("user", {
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: {
              output: block.content,
              ...(block.is_error ? { error: true } : {}),
            },
          },
        });
      } else
        throw new ProviderRequestError(`Unsupported content type: ${type}`);
    }
  }
  if (endpoint === "responses") {
    if (payload.instructions !== undefined)
      await blocks(payload.instructions, "user", true);
    if (typeof payload.input === "string") await blocks(payload.input, "user");
    else
      for (const item of records(payload.input ?? [], "input")) {
        const type = string(item.type ?? "message", "Responses input type");
        if (type === "message") {
          if (
            !["user", "assistant", "system", "developer"].includes(
              String(item.role),
            )
          )
            throw new ProviderRequestError("Unsupported message role");
          const role = item.role === "assistant" ? "model" : "user";
          await blocks(
            item.content,
            role,
            ["system", "developer"].includes(String(item.role)),
          );
        } else if (type === "reasoning") {
          if (item.encrypted_content)
            await replay(
              item.encrypted_content,
              "model",
              Array.isArray(item.summary)
                ? records(item.summary, "reasoning summary")
                    .map((part) => string(part.text, "reasoning summary text"))
                    .join("")
                : undefined,
            );
        } else if (type === "function_call" || type === "custom_tool_call") {
          const id = string(item.call_id, "call_id");
          const name = toolName(
            tools,
            string(item.name, "tool name"),
            typeof item.namespace === "string" ? item.namespace : undefined,
          );
          calls.set(id, { name, id });
          const args =
            type === "custom_tool_call"
              ? { input: string(item.input, "custom tool input") }
              : json(item.arguments ?? "{}", "tool arguments");
          append("model", { functionCall: { name, args, id } });
        } else if (
          type === "function_call_output" ||
          type === "custom_tool_call_output"
        ) {
          const id = string(item.call_id, "call_id");
          const call = calls.get(id);
          if (!call)
            throw new ProviderRequestError(
              `Tool output has no matching call: ${id}`,
            );
          append("user", {
            functionResponse: {
              name: call.name,
              ...(call.id ? { id: call.id } : {}),
              response: { output: item.output },
            },
          });
        } else
          throw new ProviderRequestError(
            `Unsupported Responses input type: ${type}`,
          );
      }
  } else {
    if (payload.system !== undefined)
      await blocks(payload.system, "user", true);
    for (const message of records(payload.messages, "messages")) {
      if (!["assistant", "user"].includes(String(message.role)))
        throw new ProviderRequestError(
          "Messages must have a user or assistant role",
        );
      await blocks(
        message.content,
        message.role === "assistant" ? "model" : "user",
      );
    }
  }
  if (!contents.length)
    throw new ProviderRequestError(
      "At least one conversation message is required",
    );
  const generation: Record<string, unknown> = {};
  for (const [source, destination] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["max_tokens", "maxOutputTokens"],
    ["max_output_tokens", "maxOutputTokens"],
  ]) {
    if (payload[source] !== undefined) {
      const value = z.number().safeParse(payload[source]);
      if (!value.success)
        throw new ProviderRequestError(`${source} must be a finite number`);
      if (
        destination === "maxOutputTokens" &&
        (!Number.isSafeInteger(value.data) || value.data <= 0)
      )
        throw new ProviderRequestError(`${source} must be a positive integer`);
      generation[destination] = value.data;
    }
  }
  const stops = payload.stop_sequences ?? payload.stop;
  if (stops !== undefined)
    generation.stopSequences =
      typeof stops === "string" ? [stops] : z.array(z.string()).parse(stops);
  const reasoning = object(payload.reasoning);
  const thinking = object(payload.thinking);
  const claude = scope.model.toLowerCase().includes("claude");
  const geminiLevel = /^gemini-(?:3[.-]|pro-agent)/i.test(scope.model);
  const requestedEffort =
    reasoning.effort ?? object(payload.output_config).effort;
  const effort =
    requestedEffort == null
      ? undefined
      : string(requestedEffort, "reasoning effort");
  if (
    thinking.budget_tokens !== undefined &&
    !z.number().int().nonnegative().safeParse(thinking.budget_tokens).success
  )
    throw new ProviderRequestError(
      "thinking.budget_tokens must be a non-negative integer",
    );
  if (thinking.type === "disabled" || effort === "none") {
    if (!claude)
      generation.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
  } else if (thinking.type || effort) {
    const budgets: Record<string, number> = {
      minimal: 1024,
      low: 2048,
      medium: 8192,
      high: 16384,
      xhigh: 24576,
      max: 24576,
    };
    if (effort && effort !== "auto" && !Object.hasOwn(budgets, effort))
      throw new ProviderRequestError("Unsupported reasoning effort");
    if (
      geminiLevel &&
      effort &&
      effort !== "auto" &&
      thinking.budget_tokens === undefined
    ) {
      let level =
        effort === "minimal"
          ? "low"
          : ["max", "xhigh"].includes(effort)
            ? "high"
            : effort;
      if (/^gemini-3-pro/i.test(scope.model) && level === "medium")
        level = "high";
      generation.thinkingConfig = {
        thinkingLevel: level,
        includeThoughts: true,
      };
    } else {
      let budget =
        typeof thinking.budget_tokens === "number"
          ? thinking.budget_tokens
          : effort === "auto" || (thinking.type === "adaptive" && !effort)
            ? -1
            : (budgets[effort ?? "medium"] ?? 8192);
      // Match Antigravity's Claude budget constraints without raising the client's output limit.
      if (
        claude &&
        typeof generation.maxOutputTokens === "number" &&
        budget >= generation.maxOutputTokens
      )
        budget = generation.maxOutputTokens - 1;
      if (!claude || budget === -1 || budget >= 1024)
        generation.thinkingConfig = {
          thinkingBudget: budget,
          includeThoughts: true,
        };
    }
  }
  const format = object(
    object(payload.text).format ??
      object(payload.output_config).format ??
      payload.response_format,
  );
  if (format.type === "json_schema" || format.type === "json_object") {
    generation.responseMimeType = "application/json";
    const schema = format.schema ?? object(format.json_schema).schema;
    if (schema) generation.responseJsonSchema = nativeSchema(schema);
  }
  const request: Record<string, unknown> = {
    contents,
    generationConfig: generation,
  };
  if (system.length)
    request.systemInstruction = { role: "user", parts: system };
  if (tools.length)
    request.tools = [
      { functionDeclarations: tools.map((tool) => tool.declaration) },
    ];
  const choice = payload.tool_choice;
  const choiceObject = object(choice);
  if (tools.length || claude) {
    const mode =
      choice === "none" || choiceObject.type === "none"
        ? "NONE"
        : choice === "required" ||
            ["any", "tool", "function", "custom"].includes(
              String(choiceObject.type),
            )
          ? "ANY"
          : claude
            ? "VALIDATED"
            : "AUTO";
    const name = choiceObject.name ?? object(choiceObject.function).name;
    request.toolConfig = {
      functionCallingConfig: {
        mode,
        ...(typeof name === "string"
          ? {
              allowedFunctionNames: [
                toolName(
                  tools,
                  name,
                  typeof choiceObject.namespace === "string"
                    ? choiceObject.namespace
                    : undefined,
                ),
              ],
            }
          : {}),
      },
    };
  }
  if (sessionId) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${scope.client_id}:${sessionId}`),
      ),
    );
    request.sessionId = new DataView(digest.buffer).getBigUint64(0).toString();
  }
  if (endpoint === "messages/count_tokens") {
    delete request.toolConfig;
    delete request.sessionId;
  }
  return { request, tools };
}
