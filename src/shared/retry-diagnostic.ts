/** Bounded decision metadata shared by request logs, usage storage and the console. */
export const RETRY_EVENT_TYPE_PATTERN = /^[\w.:-]{1,160}$/;

export const RETRY_REASONS = [
  "status_match",
  "error_code_match",
  "policy_disabled",
  "attempts_exhausted",
  "provider_terminal",
  "status_not_matched",
  "upgrade",
  "unsupported_response",
  "output_observed",
  "invalid_envelope",
  "event_type_mismatch",
  "terminal_event",
  "non_failure_status",
  "unrecognized_event",
  "error_code_not_matched",
  "stream_ended",
  "inspection_timeout",
  "inspection_limit",
  "invalid_sse",
] as const;

export interface RetryDiagnostic {
  reason: (typeof RETRY_REASONS)[number];
  event_type?: string | undefined;
  error_code?: string | undefined;
}
