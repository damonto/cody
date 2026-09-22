import {
  calculateCost,
  emptyCost,
  priceVersion,
} from "../billing/calculate.ts";
import {
  USAGE_FIELDS,
  type ModelPolicy,
  type NormalizedUsage,
} from "../billing/types.ts";
import type { GatewayConfig } from "../config/types.ts";
import type { ApiProtocol } from "../gateway/protocol.ts";
import { logWarn, type LogExecutionContext } from "../shared/log.ts";
import { deltaSignal, generationSignal } from "./generation.ts";
import { MAX_OBSERVED_JSON_CHARS, SseObserver } from "./stream.ts";
import type { AttemptRecord, RequestOutcome, UsageEvent } from "./types.ts";
import { record, UsageAccumulator } from "./usage.ts";

export interface UsageSink {
  send(event: UsageEvent): Promise<unknown>;
}

export interface MeterTarget {
  providerId: string;
  credentialId: string;
  model: string;
}

export interface MeterAttempt {
  attempt: number;
  status?: number;
  duration_ms: number;
  retry_delay_ms?: number;
  usage?: NormalizedUsage | null;
}

interface MeterOptionsBase {
  requestId: string;
  protocol: ApiProtocol;
  sink: UsageSink;
  executionContext?: LogExecutionContext;
  connectionId?: string;
  startedAt?: number;
  now?: () => number;
}

interface HttpMeterOptions extends MeterOptionsBase {
  endpoint: "messages" | "responses";
  method: "POST";
  websocket?: false;
}

interface WebSocketMeterOptions extends MeterOptionsBase {
  endpoint: "responses";
  method: "WS";
  websocket: true;
}

export type MeterOptions = HttpMeterOptions | WebSocketMeterOptions;

const TYPE_PREFIX = /^\{\s*"type"\s*:\s*"([^"\\]{0,160})"/;

/** Reads the event type from the head of an SSE data payload without parsing it. */
function peekType(data: string, event: string): string {
  return TYPE_PREFIX.exec(data.slice(0, 200))?.[1] ?? event;
}

function name(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 256) : "";
}

export class RequestMeter {
  private readonly now: () => number;
  private readonly accumulator: UsageAccumulator;
  private readonly work: Promise<boolean>[] = [];
  private terminalDelivery: Promise<boolean> | undefined;
  private readonly data: UsageEvent;
  private policy: ModelPolicy | undefined;
  private config: GatewayConfig | undefined;
  private finished = false;
  private wrapped = false;
  private streamCompleted = false;

  constructor(private readonly options: MeterOptions) {
    const endpointAllowed =
      options.endpoint === "responses" ||
      (!options.websocket && options.endpoint === "messages");
    const methodAllowed =
      options.method === (options.websocket ? "WS" : "POST");
    if (!endpointAllowed || !methodAllowed) {
      throw new Error("Only inference requests can be metered");
    }
    this.now = options.now ?? Date.now;
    this.accumulator = new UsageAccumulator(options.protocol);
    this.data = {
      schema_version: 2,
      sequence: 0,
      phase: "started",
      request_id: options.requestId,
      connection_id: options.connectionId ?? null,
      response_id: null,
      started_at: options.startedAt ?? this.now(),
      finished_at: null,
      client_id: "",
      provider_id: "",
      credential_id: "",
      model: "",
      requested_model: "",
      reported_model: "",
      endpoint: options.endpoint,
      method: options.method,
      protocol: options.protocol,
      transport: options.websocket ? "websocket" : "http",
      kind: "inference",
      outcome: "pending",
      http_status: null,
      diagnostic_code: null,
      duration_ms: null,
      first_response_ms: null,
      ttft_ms: null,
      first_text_ms: null,
      context_tokens: null,
      context_window: null,
      context_source: "unavailable",
      config_revision: null,
      observation_issue: null,
      usage: this.accumulator.snapshot(),
      billing: emptyCost(),
      attempts: [],
    };
    this.send(this.data);
  }

  private send(event: UsageEvent): UsageEvent {
    // The sink owns its copy; this.data remains mutable for later phases.
    const snapshot = structuredClone(event);
    const task = Promise.resolve()
      .then(() => this.options.sink.send(snapshot))
      .then(() => true)
      .catch(() => {
        logWarn("usage.delivery.failed", {
          request_id: snapshot.request_id,
          phase: snapshot.phase,
        });
        return false;
      });
    if (snapshot.phase === "finished") this.terminalDelivery = task;
    this.work.push(task);
    this.options.executionContext?.waitUntil?.(task);
    return snapshot;
  }

  async drain(): Promise<boolean> {
    const results = await Promise.all(this.work);
    return this.terminalDelivery
      ? this.terminalDelivery
      : results.every(Boolean);
  }

  private announceSelection(): void {
    if (this.finished || this.data.sequence !== 0) return;
    this.data.sequence = 1;
    this.data.billing.currency = this.policy?.pricing?.currency ?? "";
    this.send(this.data);
  }

  checkpoint(): UsageEvent {
    return structuredClone({
      ...this.data,
      usage: this.accumulator.snapshot(this.policy),
    });
  }

  configure(config: GatewayConfig): void {
    this.config = config;
    this.data.config_revision = config.revision ?? null;
    this.selectPolicy();
  }

  private selectPolicy(): void {
    if (this.data.sequence !== 0) return;
    const policy = this.config?.model_policies?.find(
      (policy) =>
        policy.provider_id === this.data.provider_id &&
        policy.model === this.data.model,
    );
    this.policy = policy ? structuredClone(policy) : undefined;
    this.data.context_window = this.policy?.context_window ?? null;
  }

  authenticate(clientId: string): void {
    if (!this.finished && this.data.sequence === 0)
      this.data.client_id = clientId;
  }

  requestedModel(model: string): void {
    if (!this.finished && this.data.sequence === 0)
      this.data.requested_model = name(model);
  }

  select(target: MeterTarget): void {
    if (this.finished || this.data.sequence !== 0) return;
    this.data.provider_id = target.providerId;
    this.data.credential_id = target.credentialId;
    this.data.model = target.model;
    this.selectPolicy();
    this.announceSelection();
  }

  recordAttempts(attempts: readonly MeterAttempt[]): void {
    if (this.finished) return;
    this.data.attempts = attempts
      .slice(0, 20)
      .map((attempt): AttemptRecord => ({
        attempt: attempt.attempt,
        status: attempt.status ?? null,
        duration_ms: attempt.duration_ms,
        retry_delay_ms: attempt.retry_delay_ms ?? null,
        usage: attempt.usage ?? null,
        billing: null,
      }));
  }

  diagnostic(code: string): void {
    if (!this.finished) this.data.diagnostic_code = name(code);
  }

  issue(value: string): void {
    this.data.observation_issue ??= value;
  }

  observe(value: unknown, event = "", at = this.now()): void {
    this.observePayload(value, event, at);
  }

  /**
   * Content deltas are the bulk of a stream and only matter until the first
   * token timings are known, so parsing them afterwards is wasted CPU.
   */
  private needsEvent(data: string, event: string): boolean {
    const signal = deltaSignal(peekType(data, event));
    if (signal === "text") return this.data.first_text_ms === null;
    if (signal === "generation") return this.data.ttft_ms === null;
    return true;
  }

  private observeFirstResponse(at: number): void {
    if (!this.finished)
      this.data.first_response_ms ??= Math.max(0, at - this.data.started_at);
  }

  private observePayload(
    value: unknown,
    event: string,
    at: number | null,
  ): void {
    if (this.finished) return;
    const payload = record(value);
    if (!payload) return;
    const response = record(payload.response);
    const message = record(payload.message);
    this.accumulator.add(payload.usage);
    this.accumulator.add(response?.usage);
    this.accumulator.add(message?.usage);
    const type = name(payload.type) || event;
    if (
      [
        "response.completed",
        "response.failed",
        "response.incomplete",
        "message_stop",
      ].includes(type)
    )
      this.streamCompleted = true;
    const responseId =
      response?.id ?? (payload.object === "response" ? payload.id : undefined);
    if (typeof responseId === "string")
      this.data.response_id = name(responseId);
    const model = response?.model ?? payload.model ?? message?.model;
    if (typeof model === "string") this.data.reported_model = name(model);
    if (
      Array.isArray(payload.choices) &&
      payload.choices.some((item) => record(item)?.finish_reason)
    )
      this.streamCompleted = true;
    if (at !== null) {
      this.observeFirstResponse(at);
      const signal = generationSignal(payload, type);
      if (signal) this.data.ttft_ms ??= Math.max(0, at - this.data.started_at);
      if (signal === "text")
        this.data.first_text_ms ??= Math.max(0, at - this.data.started_at);
    }
    if (
      type === "error" ||
      type === "response.failed" ||
      payload.error ||
      response?.status === "failed"
    ) {
      this.data.outcome = "failed";
      this.data.diagnostic_code =
        name(record(payload.error ?? response?.error)?.code) ||
        "upstream_stream_error";
    } else if (
      type === "response.incomplete" ||
      response?.status === "incomplete" ||
      payload.status === "incomplete"
    ) {
      this.data.outcome = "incomplete";
    }
  }

  finish(
    outcome: Exclude<RequestOutcome, "pending">,
    status: number | null = this.data.http_status,
  ): UsageEvent {
    if (this.finished) return structuredClone(this.data);
    this.finished = true;
    this.data.phase = "finished";
    this.data.sequence = 2;
    this.data.finished_at = this.now();
    this.data.duration_ms = Math.max(
      0,
      this.data.finished_at - this.data.started_at,
    );
    this.data.http_status = status;
    if (
      this.data.outcome === "pending" ||
      outcome === "cancelled" ||
      outcome === "failed"
    )
      this.data.outcome = outcome;
    const usage = this.accumulator.snapshot(this.policy);
    this.data.context_tokens = usage.tokens.input_tokens;
    this.data.context_source =
      usage.tokens.input_tokens === null ? "unavailable" : "reported_input";
    this.data.usage = usage;
    const version = this.policy
      ? priceVersion(
          this.data.config_revision ?? undefined,
          this.data.provider_id,
          this.data.model,
        )
      : null;
    try {
      this.data.billing =
        usage.status !== "invalid"
          ? calculateCost(usage.tokens, this.policy, version)
          : emptyCost("unknown");
      const last = this.data.attempts.at(-1);
      if (last) {
        last.usage = structuredClone(usage);
        last.billing = structuredClone(this.data.billing);
      }
      for (const attempt of this.data.attempts.slice(0, -1)) {
        if (!attempt.usage) {
          this.data.usage.status =
            this.data.usage.status === "invalid" ? "invalid" : "partial";
          if (this.data.billing.status === "complete")
            this.data.billing.status = "partial";
          continue;
        }
        const previousUsage = new UsageAccumulator(this.options.protocol);
        previousUsage.add(attempt.usage.raw);
        attempt.usage = previousUsage.snapshot(this.policy);
        attempt.billing =
          attempt.usage.status === "invalid"
            ? emptyCost("unknown")
            : calculateCost(attempt.usage.tokens, this.policy, version);
        for (const field of USAGE_FIELDS) {
          const previous = attempt.usage.tokens[field];
          if (previous !== null) {
            const total = (this.data.usage.tokens[field] ?? 0) + previous;
            if (!Number.isSafeInteger(total))
              throw new Error("Usage exceeds supported precision");
            this.data.usage.tokens[field] = total;
          }
        }
        for (const field of [
          "input_nano",
          "output_nano",
          "cache_write_nano",
          "cache_read_nano",
          "total_nano",
        ] as const) {
          const previous = attempt.billing[field];
          if (previous !== null) {
            const total = (this.data.billing[field] ?? 0) + previous;
            if (!Number.isSafeInteger(total))
              throw new Error("Cost exceeds supported precision");
            this.data.billing[field] = total;
          }
        }
        if (attempt.usage.status === "invalid")
          this.data.usage.status = "invalid";
        else if (
          attempt.usage.status !== "reported" &&
          this.data.usage.status !== "invalid"
        )
          this.data.usage.status = "partial";
        if (
          attempt.billing.status !== "complete" &&
          this.data.billing.status === "complete"
        )
          this.data.billing.status = "partial";
      }
    } catch {
      this.data.billing = emptyCost("unknown");
      this.issue("billing_calculation_failed");
    }
    if (this.data.observation_issue && this.data.usage.status === "reported")
      this.data.usage.status = "partial";
    return this.send(this.data);
  }

  response(response: Response): Response {
    if (this.wrapped) return response;
    this.wrapped = true;
    this.data.http_status = response.status;
    if (!response.body) {
      this.finish(response.ok ? "success" : "failed", response.status);
      return response;
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    const sse = contentType.includes("text/event-stream");
    if (sse) this.data.transport = "sse";
    const json =
      !sse &&
      (contentType.includes("application/json") ||
        contentType.includes("+json"));
    const decoder = new TextDecoder();
    const observer = sse
      ? new SseObserver({
          onEvent: (value, event) => this.observe(value, event),
          onIssue: (issue) => this.issue(issue),
          onDone: () => {
            this.streamCompleted = true;
          },
          onFirstData: () => this.observeFirstResponse(this.now()),
          shouldParse: (data, event) => this.needsEvent(data, event),
        })
      : undefined;
    let jsonBody = "";
    let tooLarge = false;
    const observeChunk = (bytes: Uint8Array): void => {
      if (!sse && !json) return;
      const text = decoder.decode(bytes, { stream: true });
      if (observer) observer.push(text);
      else if (!tooLarge) {
        if (jsonBody.length + text.length > MAX_OBSERVED_JSON_CHARS) {
          tooLarge = true;
          jsonBody = "";
          this.issue("json_body_too_large");
        } else jsonBody += text;
      }
    };
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const item = await reader.read();
          if (item.done) {
            try {
              if (observer) {
                observer.push(decoder.decode());
                observer.end();
              } else if (json && !tooLarge)
                this.observePayload(
                  JSON.parse(jsonBody + decoder.decode()) as unknown,
                  "",
                  null,
                );
            } catch {
              this.issue("invalid_response_json");
            }
            if (
              sse &&
              response.ok &&
              !this.streamCompleted &&
              this.data.outcome === "pending"
            ) {
              this.issue("stream_ended_without_completion");
              this.finish("incomplete", response.status);
            } else
              this.finish(response.ok ? "success" : "failed", response.status);
            controller.close();
          } else {
            try {
              observeChunk(item.value);
            } catch {
              this.issue("response_observer_failed");
            }
            controller.enqueue(item.value);
          }
        } catch (error) {
          this.issue("upstream_stream_read_failed");
          this.finish("failed", response.status);
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        this.finish("cancelled", response.status);
        await reader.cancel(reason);
      },
    });
    return new Response(body, response);
  }
}
