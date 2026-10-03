import type { NativePart } from "./replay.ts";

export const INTERLEAVED_THINKING_HINT =
  "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";

/** Only system text is rewritten. Conversation history and native signatures stay intact. */
export function antigravitySystemParts(
  parts: readonly NativePart[],
  interleavedThinking: boolean,
  sensitiveWords: readonly string[] = [],
): NativePart[] {
  const system = [...parts];
  if (
    interleavedThinking &&
    !system.some((part) => part.text === INTERLEAVED_THINKING_HINT)
  )
    system.push({ text: INTERLEAVED_THINKING_HINT });
  const words = [...new Set(sensitiveWords.map((word) => word.trim()))]
    .filter((word) => Array.from(word).length >= 2 && !word.includes("\u200b"))
    .sort((a, b) => b.length - a.length);
  if (!words.length) return system;
  const matcher = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  return system.map((part) =>
    typeof part.text === "string"
      ? {
          ...part,
          text: part.text.replace(matcher, (word) => {
            // Match Go's first-rune insertion, including supplementary Unicode characters.
            const [first, ...rest] = Array.from(word);
            return `${first}\u200b${rest.join("")}`;
          }),
        }
      : part,
  );
}
