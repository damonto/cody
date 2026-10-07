import type { RetryDiagnostic } from "../../../../src/shared/retry-diagnostic.ts";

const reasons: Record<RetryDiagnostic["reason"], string> = {
  status_match: "HTTP status matched retry policy",
  error_code_match: "Error code matched retry policy",
  policy_disabled: "Retry policy not configured",
  attempts_exhausted: "No retries remaining",
  provider_terminal: "Provider requires terminal handling",
  status_not_matched: "HTTP status did not match retry policy",
  upgrade: "Upgraded connection cannot be replayed",
  unsupported_response: "Response body cannot be inspected",
  output_observed: "Output detected; retry inspection stopped",
  invalid_envelope: "Unrecognized payload structure",
  event_type_mismatch: "SSE event and payload types disagree",
  terminal_event: "Output or terminal event ended retry inspection",
  non_failure_status: "Response status does not indicate failure",
  unrecognized_event: "Unrecognized event ended retry inspection",
  error_code_not_matched: "Error code did not match retry policy",
  stream_ended: "Stream ended without a matching error",
  inspection_timeout: "Retry inspection time limit reached",
  inspection_limit: "Retry inspection size limit reached",
  invalid_sse: "SSE event could not be parsed within inspection limits",
};

export function RetryDecision({ value }: { value?: RetryDiagnostic }) {
  if (!value)
    return <span className="text-muted-foreground">Not recorded</span>;
  return (
    <div className="min-w-48 max-w-72 whitespace-normal">
      <p>{reasons[value.reason]}</p>
      {value.event_type ? (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          Event: {value.event_type}
        </p>
      ) : null}
      {value.error_code ? (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          Error: {value.error_code}
        </p>
      ) : null}
    </div>
  );
}
