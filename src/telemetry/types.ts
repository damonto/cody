import type { CostBreakdown, NormalizedUsage } from "../billing/types.ts";
import type { ApiProtocol } from "../gateway/protocol.ts";

export type RequestOutcome =
  "pending" | "success" | "failed" | "cancelled" | "incomplete";

export interface AttemptRecord {
  attempt: number;
  status: number | null;
  duration_ms: number;
  retry_delay_ms: number | null;
  usage: NormalizedUsage | null;
  billing: CostBreakdown | null;
}

export interface UsageEvent {
  schema_version: 1;
  sequence: 0 | 1 | 2;
  phase: "started" | "finished";
  request_id: string;
  connection_id: string | null;
  response_id: string | null;
  started_at: number;
  finished_at: number | null;
  client_id: string;
  service_id: string;
  key_id: string;
  model: string;
  requested_model: string;
  reported_model: string;
  endpoint: string;
  method: string;
  protocol: ApiProtocol;
  transport: "http" | "sse" | "websocket";
  kind: "inference";
  outcome: RequestOutcome;
  http_status: number | null;
  diagnostic_code: string | null;
  duration_ms: number | null;
  /** First SSE data or WebSocket event, including lifecycle events; absent in older records. */
  first_response_ms?: number | null;
  ttft_ms: number | null;
  first_text_ms: number | null;
  context_tokens: number | null;
  context_window: number | null;
  context_source: "reported_input" | "unavailable";
  config_revision: number | null;
  observation_issue: string | null;
  usage: NormalizedUsage;
  billing: CostBreakdown;
  attempts: AttemptRecord[];
}
