import { logWarn } from "../../shared/log.ts";
import { RequestMeter, type UsageSink } from "../../telemetry/meter.ts";
import type { UsageEvent } from "../../telemetry/types.ts";
import { record } from "../../telemetry/usage.ts";
import type { ModelServiceTarget } from "../routing/routing.ts";
import type { CurrentRoutingContext } from "./routing.ts";
import type { WebSocketStorage } from "./storage.ts";

type Outcome = "success" | "failed" | "cancelled" | "incomplete";

/** Owns per-generation metering and delivery; it never operates on sockets. */
export class WebSocketUsage {
  private readonly meters = new Set<RequestMeter>();
  private readonly responses = new Map<string, RequestMeter>();
  private readonly completed = new Set<string>();
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly storage: WebSocketStorage,
    private readonly sink: UsageSink | undefined,
    private readonly context: Pick<DurableObjectState, "waitUntil">,
  ) {}

  async start(
    connectionId: string,
    model: string,
    startedAt: number,
  ): Promise<RequestMeter | undefined> {
    const sink = this.sink;
    if (!sink) return undefined;
    const meter = new RequestMeter({
      requestId: crypto.randomUUID(),
      connectionId,
      endpoint: "responses",
      method: "WS",
      protocol: "openai",
      websocket: true,
      startedAt,
      sink: {
        send: async (event) => {
          if (event.phase === "finished") await this.storage.finish(event);
          return sink.send(event);
        },
      },
      executionContext: this.context,
    });
    meter.requestedModel(model);
    this.meters.add(meter);
    await this.storage.checkpoint(meter.checkpoint());
    return meter;
  }

  async select(
    meter: RequestMeter | undefined,
    context: CurrentRoutingContext,
    target?: ModelServiceTarget,
  ): Promise<void> {
    if (!meter || !this.meters.has(meter)) return;
    meter.configure(context.config);
    meter.authenticate(context.client.id);
    if (target)
      meter.select({
        serviceId: target.service.id,
        keyId: target.key.id,
        model: target.upstreamModel,
      });
    await this.storage.checkpoint(meter.checkpoint());
  }

  observe(
    payload: Record<string, unknown>,
    receivedAt: number,
  ): RequestMeter | undefined {
    const responseId =
      typeof payload.response_id === "string"
        ? payload.response_id
        : record(payload.response)?.id;
    const id = typeof responseId === "string" ? responseId : undefined;
    let meter = id ? this.responses.get(id) : undefined;
    if (!meter && (!id || !this.completed.has(id))) {
      const assigned = new Set(this.responses.values());
      meter = [...this.meters].find((entry) => !id || !assigned.has(entry));
      if (meter && id) this.responses.set(id, meter);
    }
    meter?.observe(payload, "", receivedAt);
    return meter;
  }

  finish(
    meter: RequestMeter,
    outcome: Outcome,
    status: number | null = null,
  ): void {
    const event = meter.finish(outcome, status);
    this.meters.delete(meter);
    for (const [id, value] of this.responses) {
      if (value !== meter) continue;
      this.responses.delete(id);
      this.completed.add(id);
    }
    for (const id of this.completed) {
      if (this.completed.size <= 256) break;
      this.completed.delete(id);
    }
    this.context.waitUntil(this.settle(meter, event));
  }

  finishAll(outcome: Outcome, diagnostic: string): void {
    for (const meter of this.meters) {
      meter.diagnostic(diagnostic);
      this.finish(meter, outcome);
    }
  }

  private async settle(meter: RequestMeter, event: UsageEvent): Promise<void> {
    if (await meter.drain())
      await this.storage.acknowledgeUsage(event.request_id);
    else await this.storage.scheduleAlarm();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    if (!this.sink) return;
    try {
      const pending = await this.storage.pendingUsage();
      for (const event of pending.values()) {
        try {
          await this.sink.send(event);
          await this.storage.acknowledgeUsage(event.request_id);
        } catch {
          logWarn("usage.recovery.failed", { request_id: event.request_id });
        }
      }
    } finally {
      await this.storage.scheduleAlarm();
    }
  }
}
