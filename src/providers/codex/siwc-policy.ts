import type { ProviderEndpoint, ProviderRequest } from "../types.ts";
import { ProviderTransport } from "../transport-values.ts";
import { ProviderRequestError } from "../errors.ts";
import type { CodexMode } from "./account-schema.ts";

export interface CodexRequestPolicy {
  endpoint: ProviderEndpoint;
  transport: ProviderTransport;
  payload?: Readonly<Record<string, unknown>> | undefined;
  mode?: CodexMode | undefined;
}
const unsupportedFields = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
];
const unsupportedTools = new Set([
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use_preview",
  "mcp",
  "tool_search",
  "programmatic_tool_calling",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function invalid(param: string, message: string): never {
  throw new ProviderRequestError(
    `SIWC: ${message}`,
    400,
    "siwc_unsupported_capability",
    param,
  );
}
export function validateSiwcRequest(
  input: CodexRequestPolicy | ProviderRequest,
): void {
  if (input.endpoint !== "models" && input.endpoint !== "responses")
    invalid("endpoint", "this endpoint is unavailable; use Responses");
  if (input.endpoint === "models") return;
  const body = input.payload;
  // The WebSocket handshake has no inference body; every response.create is checked separately.
  if (!body && input.transport === ProviderTransport.Websocket) return;
  if (!body || body.store !== false) invalid("store", "set store to false");
  if (input.transport === ProviderTransport.Http) {
    if (body.stream !== true) invalid("stream", "set stream to true");
    if ("previous_response_id" in body)
      invalid(
        "previous_response_id",
        "send the complete input history over HTTP",
      );
  } else if ("stream" in body)
    invalid("stream", "omit stream for WebSocket requests");
  if (!Array.isArray(body.input)) invalid("input", "input must be an array");
  for (const field of unsupportedFields)
    if (field in body) invalid(field, `${field} is unsupported`);
  const tools = (values: unknown, path: string): void => {
    const groups = [{ values, path }];
    for (let group = groups.pop(); group; group = groups.pop()) {
      if (!Array.isArray(group.values)) continue;
      const groupPath = group.path;
      group.values.forEach((tool: unknown, index: number) => {
        if (!record(tool)) return;
        const param = `${groupPath}[${index}]`;
        if (typeof tool.type === "string" && unsupportedTools.has(tool.type))
          invalid(param, `${tool.type} tools are unsupported`);
        if (tool.type === "namespace")
          groups.push({ values: tool.tools, path: `${param}.tools` });
        if (
          groupPath === "tools" &&
          (tool.type === "function" || tool.type === "custom")
        )
          invalid(
            param,
            "group function/custom tools in namespaces or additional_tools input items",
          );
      });
    }
  };

  tools(body.tools, "tools");
  if (
    record(body.tool_choice) &&
    typeof body.tool_choice.type === "string" &&
    unsupportedTools.has(body.tool_choice.type)
  )
    invalid("tool_choice", `${body.tool_choice.type} tools are unsupported`);
  body.input.forEach((item: unknown, index: number) => {
    if (!record(item)) return;
    if (item.role === "system")
      invalid(`input[${index}].role`, "use instructions or developer messages");
    if (Array.isArray(item.content))
      item.content.forEach((part: unknown, partIndex: number) => {
        if (
          record(part) &&
          (part.type === "input_audio" || part.type === "input_video")
        )
          invalid(
            `input[${index}].content[${partIndex}].type`,
            "audio/video inputs are unsupported",
          );
      });
    if (item.type === "additional_tools")
      tools(item.tools, `input[${index}].tools`);
    if (item.type === "configuration_update")
      invalid(`input[${index}].type`, "configuration_update is unsupported");
  });
}
