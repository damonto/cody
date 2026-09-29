import { object, records, text, type Wire } from "./json.ts";

const INTERNAL_NAMES = new Set([
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
]);

/** Native X Search traces are server work, not calls the downstream client should run. */
export class XaiSearchFilter {
  private readonly indexes = new Set<number>();
  private readonly ids = new Set<string>();
  private hidden(item: Wire, anthropic: boolean): boolean {
    return (
      (anthropic &&
        ["web_search_call", "x_search_call"].includes(text(item.type))) ||
      (["function_call", "custom_tool_call"].includes(text(item.type)) &&
        !item.namespace &&
        INTERNAL_NAMES.has(text(item.name)))
    );
  }
  apply(event: Wire, anthropic: boolean): Wire | undefined {
    const item = object(event.item);
    if (this.hidden(item, anthropic)) {
      if (typeof event.output_index === "number")
        this.indexes.add(event.output_index);
      if (typeof item.id === "string") this.ids.add(item.id);
      return undefined;
    }
    if (
      (typeof event.output_index === "number" &&
        this.indexes.has(event.output_index)) ||
      this.ids.has(text(event.item_id))
    )
      return undefined;
    const response = object(event.response);
    if (Array.isArray(response.output))
      return {
        ...event,
        response: {
          ...response,
          output: records(response.output).filter(
            (part) => !this.hidden(part, anthropic),
          ),
        },
      };
    return event;
  }
}
