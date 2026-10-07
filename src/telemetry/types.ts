import {
  type RequestOutcome,
  type UsagePhase,
  type UsageTransport,
  type ContextSource,
} from "./values.ts";
import { type ApiProtocol } from "../gateway/protocol-values.ts";

import type { CostBreakdown, NormalizedUsage } from "../billing/types.ts";
import type { UpstreamObservation } from "../shared/upstream-observation.ts";

export type { RequestOutcome } from "./values.ts";

export interface AttemptRecord {
  attempt: number;
  status: number | null;
  duration_ms: number;
  retry_delay_ms: number | null;
  usage: NormalizedUsage | null;
  billing: CostBreakdown | null;
}

export interface UsageEvent {
  schema_version: 2;
  sequence: 0 | 1 | 2;
  phase: UsagePhase;
  request_id: string;
  connection_id: string | null;
  response_id: string | null;
  started_at: number;
  finished_at: number | null;
  client_id: string;
  provider_id: string;
  credential_id: string;
  /** Canonical model identity used by reports. */
  model: string;
  /** Exact execution model; absent in events recorded before this metadata was added. */
  upstream_model?: string | undefined;
  requested_model: string;
  reported_model: string;
  /** Final wire request and original upstream response; absent in historical events. */
  upstream_observation?: UpstreamObservation | undefined;
  endpoint: string;
  method: string;
  protocol: ApiProtocol;
  transport: UsageTransport;
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
  context_source: ContextSource;
  config_revision: number | null;
  observation_issue: string | null;
  usage: NormalizedUsage;
  billing: CostBreakdown;
  attempts: AttemptRecord[];
}
