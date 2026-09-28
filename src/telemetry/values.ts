/** Stable wire values shared by runtime schemas and consumers. */

export const RequestOutcome = {
  Pending: "pending",
  Success: "success",
  Failed: "failed",
  Cancelled: "cancelled",
  Incomplete: "incomplete",
} as const;

export type RequestOutcome =
  (typeof RequestOutcome)[keyof typeof RequestOutcome];

export const UsagePhase = {
  Started: "started",
  Finished: "finished",
} as const;

export type UsagePhase = (typeof UsagePhase)[keyof typeof UsagePhase];

export const UsageTransport = {
  Http: "http",
  Sse: "sse",
  Websocket: "websocket",
} as const;

export type UsageTransport =
  (typeof UsageTransport)[keyof typeof UsageTransport];

export const ContextSource = {
  ReportedInput: "reported_input",
  Unavailable: "unavailable",
} as const;

export type ContextSource = (typeof ContextSource)[keyof typeof ContextSource];

/** Outcomes accepted when a logical request finishes. */
export type TerminalRequestOutcome = Exclude<
  RequestOutcome,
  typeof RequestOutcome.Pending
>;
