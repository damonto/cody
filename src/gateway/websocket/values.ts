/** Stable wire values shared by runtime schemas and consumers. */

export const SessionPhase = {
  AwaitingFirstFrame: "awaiting_first_frame",
  Routing: "routing",
  Connecting: "connecting",
  Open: "open",
  Closed: "closed",
} as const;

export type SessionPhase = (typeof SessionPhase)[keyof typeof SessionPhase];
