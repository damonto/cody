import { z } from "zod";
import type { UsageEvent, AttemptRecord } from "../telemetry/types.ts";
import { parseUsageEvent } from "../telemetry/schema.ts";
import { SQL_USAGE_FIELDS, IMAGE_USAGE_FIELDS } from "../billing/types.ts";

/** Persist only facts not already represented by indexed request columns. */
export function requestDetails(event: UsageEvent): string {
  return JSON.stringify({
    connection_id: event.connection_id,
    response_id: event.response_id,
    upstream_model: event.upstream_model,
    reported_model: event.reported_model,
    upstream_observation: event.upstream_observation,
    method: event.method,
    diagnostic_code: event.diagnostic_code,
    context_source: event.context_source,
    config_revision: event.config_revision,
    observation_issue: event.observation_issue,
    usage_raw: event.usage.raw,
    image_usage: Object.fromEntries(
      IMAGE_USAGE_FIELDS.map((field) => [field, event.usage.tokens[field]]),
    ),
    billing: {
      price_version: event.billing.price_version,
      tier_index: event.billing.tier_index,
      context_tokens: event.billing.context_tokens,
      image_input_nano: event.billing.image_input_nano,
      image_output_nano: event.billing.image_output_nano,
      image_cache_read_nano: event.billing.image_cache_read_nano,
      image_cache_write_nano: event.billing.image_cache_write_nano,
      input_nano: event.billing.input_nano,
      output_nano: event.billing.output_nano,
      cache_write_nano: event.billing.cache_write_nano,
      cache_read_nano: event.billing.cache_read_nano,
    },
  });
}
export function attemptDetails(attempt: AttemptRecord): string {
  return JSON.stringify({
    retry_delay_ms: attempt.retry_delay_ms,
    usage: attempt.usage,
    billing: attempt.billing,
  });
}
const record = z.record(z.string(), z.unknown());
export function hydrateRequest(
  value: unknown,
  attempts: unknown[],
): UsageEvent {
  const row = record.parse(value);
  const details = record.parse(JSON.parse(z.string().parse(row.details_json)));
  const billing = record.parse(details.billing ?? {});
  const imageUsage = record.parse(details.image_usage ?? {});
  const event = parseUsageEvent({
    schema_version: 2,
    sequence: row.event_sequence,
    phase: row.finished_at === null ? "started" : "finished",
    request_id: row.request_id,
    connection_id: details.connection_id ?? null,
    response_id: details.response_id ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    client_id: row.client_id,
    provider_id: row.provider_id,
    credential_id: row.credential_id,
    model: row.model,
    ...(details.upstream_model === undefined
      ? {}
      : { upstream_model: details.upstream_model }),
    requested_model: row.requested_model,
    reported_model: details.reported_model ?? "",
    ...(details.upstream_observation === undefined
      ? {}
      : { upstream_observation: details.upstream_observation }),
    endpoint: row.endpoint,
    method: details.method ?? "POST",
    protocol: row.protocol,
    transport: row.transport,
    kind: row.kind,
    outcome: row.outcome,
    http_status: row.http_status,
    diagnostic_code: details.diagnostic_code ?? null,
    duration_ms: row.duration_ms,
    first_response_ms: row.first_response_ms,
    ttft_ms: row.ttft_ms,
    first_text_ms: row.first_text_ms,
    context_tokens: row.context_tokens,
    context_window: row.context_window,
    context_source: details.context_source ?? "unavailable",
    config_revision: details.config_revision ?? null,
    observation_issue: details.observation_issue ?? null,
    usage: {
      tokens: {
        ...Object.fromEntries(
          SQL_USAGE_FIELDS.map((field) => [field, row[field] ?? null]),
        ),
        ...Object.fromEntries(
          IMAGE_USAGE_FIELDS.map((field) => [field, imageUsage[field] ?? null]),
        ),
      },
      status: row.usage_status,
      raw: details.usage_raw ?? {},
    },
    billing: {
      ...billing,
      status: row.billing_status,
      currency: row.currency,
      total_nano: row.cost_nano,
    },
    attempts: attempts.map((value) => {
      const attempt = record.parse(value);
      return {
        ...record.parse(JSON.parse(z.string().parse(attempt.details_json))),
        attempt: attempt.attempt,
        status: attempt.status,
        duration_ms: attempt.duration_ms,
      };
    }),
  });
  if (!event)
    throw new Error("Unexpected non-inference request in reporting storage");
  return event;
}
