/** Stable wire values shared by runtime schemas and consumers. */

export const ProviderTransport = {
  Http: "http",
  Websocket: "websocket",
} as const;

export type ProviderTransport =
  (typeof ProviderTransport)[keyof typeof ProviderTransport];
