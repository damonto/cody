const WHITESPACE = /\s/;

interface Span {
  readonly start: number;
  readonly end: number;
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && WHITESPACE.test(text[index])) index += 1;
  return index;
}

/** Returns the index after the closing quote of the string opening at `index`. */
function skipString(text: string, index: number): number {
  index += 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  return -1;
}

/**
 * Locates the string value of the last top-level `"model"` key in a JSON
 * object without materializing the document. Returns undefined when the text
 * is not an object, the key is escaped, or the value is not a plain string.
 */
export function topLevelModelSpan(text: string): Span | undefined {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") return undefined;
  index += 1;
  let depth = 1;
  let expectKey = true;
  let found: Span | undefined;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === '"') {
      const end = skipString(text, index);
      if (end < 0) return undefined;
      if (depth === 1 && expectKey) {
        const isModel = text.slice(index, end) === '"model"';
        index = skipWhitespace(text, end);
        if (text[index] !== ":") return undefined;
        index = skipWhitespace(text, index + 1);
        expectKey = false;
        if (isModel && text[index] === '"') {
          const valueEnd = skipString(text, index);
          if (valueEnd < 0) return undefined;
          found = { start: index, end: valueEnd };
          index = valueEnd;
        }
        continue;
      }
      index = end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectKey = true;
    }
    index += 1;
  }
  return found;
}

/**
 * Produces the upstream body for a model rewrite. The client's own bytes are
 * preserved except for the `model` string, so key order, whitespace and large
 * nested content pass through without a serialization round trip. When the
 * text cannot be spliced safely, the parsed payload is serialized instead.
 */
export function rewriteModel(
  text: string,
  payload: Readonly<Record<string, unknown>>,
  model: string,
): string {
  const span = topLevelModelSpan(text);
  if (span) {
    return (
      text.slice(0, span.start) + JSON.stringify(model) + text.slice(span.end)
    );
  }
  return JSON.stringify({ ...payload, model });
}
