/** Stable wire values shared by runtime schemas and consumers. */

export const ApiProtocol = {
  Openai: "openai",
  Anthropic: "anthropic",
} as const;

export type ApiProtocol = (typeof ApiProtocol)[keyof typeof ApiProtocol];
