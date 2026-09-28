import { object, records, text, type Wire } from "./json.ts";
import { validateTokenCount } from "./validation.ts";

/** Local text estimate only; the tokenizer is never imported into the console. */
export async function estimateInputTokens(payload: Wire): Promise<number> {
  validateTokenCount(payload);
  const segments: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") segments.push(value);
    else
      for (const part of records(value)) {
        if (part.type === "text") segments.push(text(part.text));
        else if (part.type === "thinking") segments.push(text(part.thinking));
        else if (part.type === "tool_use")
          segments.push(text(part.name), JSON.stringify(part.input));
        else if (part.type === "tool_result") collect(part.content);
      }
  };
  collect(payload.system);
  for (const message of records(payload.messages)) collect(message.content);
  for (const tool of records(payload.tools))
    segments.push(
      text(tool.name),
      text(tool.description),
      JSON.stringify(tool.input_schema ?? {}),
    );
  if (object(object(payload.output_config).format).schema)
    segments.push(
      JSON.stringify(object(object(payload.output_config).format).schema),
    );
  const { countTokens } = await import("gpt-tokenizer/encoding/o200k_base");
  return countTokens(segments.join("\n"), { disallowedSpecial: new Set() });
}
