import { z } from "zod";
import { ProviderRequestError } from "../errors.ts";
import { isRecord, type Wire } from "./json.ts";

export function invalid(message: string): never {
  throw new ProviderRequestError(message, 400, "unsupported_xai_request");
}
export function requestArray(value: unknown, field: string): Wire[] {
  if (!Array.isArray(value) || !value.every(isRecord))
    invalid(`Invalid ${field}`);
  return value;
}
const name = z.string().min(1);
const record = z.record(z.string(), z.unknown());
const textPart = z.object({
  type: z.enum(["text", "input_text", "output_text"]),
  text: z.string(),
});
const imagePart = z.object({
  type: z.enum(["image", "input_image"]),
  image_url: z.string().optional(),
  source: z
    .object({
      type: z.enum(["url", "base64"]),
      url: z.string().optional(),
      media_type: z.string().optional(),
      data: z.string().optional(),
    })
    .optional(),
});
const content = z.union([
  z.string(),
  z.array(
    z.union([
      textPart,
      imagePart,
      z.object({ type: z.literal("refusal"), refusal: z.string() }),
    ]),
  ),
]);
const messages = z.array(
  z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          textPart,
          imagePart,
          z.object({
            type: z.literal("thinking"),
            thinking: z.string(),
            signature: name,
          }),
          z.object({ type: z.literal("redacted_thinking"), data: name }),
          z.object({
            type: z.literal("tool_use"),
            id: name,
            name,
            input: record,
          }),
          z.object({
            type: z.literal("tool_result"),
            tool_use_id: name,
            content: content.optional(),
            is_error: z.boolean().optional(),
          }),
        ]),
      ),
    ]),
  }),
);
const responseInput = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({
        type: z.literal("message").optional(),
        role: z.enum(["user", "assistant", "system", "developer"]),
        content,
      }),
      z.object({
        type: z.literal("reasoning"),
        encrypted_content: name,
        summary: z
          .array(
            z.object({ type: z.literal("summary_text"), text: z.string() }),
          )
          .optional(),
      }),
      z.object({
        type: z.literal("function_call"),
        call_id: name,
        name,
        arguments: z.string(),
        namespace: name.optional(),
      }),
      z.object({
        type: z.literal("custom_tool_call"),
        call_id: name,
        name,
        input: z.string(),
        namespace: name.optional(),
      }),
      z.object({
        type: z.enum(["function_call_output", "custom_tool_call_output"]),
        call_id: name,
        output: content,
      }),
    ]),
  ),
]);
const controls = z.object({
  model: name.optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().nonnegative().optional(),
  parallel_tool_calls: z.boolean().optional(),
  include: z.array(z.string()).optional(),
  reasoning: z
    .object({ effort: name.optional(), summary: name.optional() })
    .optional(),
  thinking: z
    .object({
      type: z.enum(["enabled", "disabled", "adaptive"]),
      budget_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  output_config: z
    .object({ effort: name.optional(), format: record.optional() })
    .optional(),
  tools: z.array(record).optional(),
});
const messagesRequest = controls.extend({
  messages,
  system: content.optional(),
});
const responsesRequest = controls.extend({
  input: responseInput,
  instructions: z.string().optional(),
});

/** Validate known fields without stripping unrelated client metadata. */
export function validateRequest(payload: Wire, anthropic: boolean): void {
  validateBoundary(payload, anthropic ? messagesRequest : responsesRequest);
  if (
    anthropic &&
    payload.output_config &&
    isRecord(payload.output_config) &&
    payload.output_config.format !== undefined
  )
    invalid("Messages structured output is not supported by the xAI adapter");
}

export function validateTokenCount(payload: Wire): void {
  validateBoundary(payload, messagesRequest);
}

function validateBoundary(payload: Wire, schema: z.ZodType): void {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    invalid(`Invalid xAI request field: ${issue?.path.join(".") || "body"}`);
  }
}
