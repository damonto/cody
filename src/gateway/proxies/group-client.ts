import type { GatewayConfig, ProxyGroupConfig } from "../../config/types.ts";
import { abortable } from "../../shared/abort.ts";
import { logWarn } from "../../shared/log.ts";
import type { HealthExecutionContext } from "../health/health.ts";
import { proxyGroupSnapshot } from "./configuration.ts";
import { ProxyUnavailableError } from "./errors.ts";
import {
  proxySelectionSchema,
  type ProxyGroupSnapshot,
  type ProxyLease,
  type ProxyOutcome,
  type ProxyOwner,
} from "./schema.ts";
import type { Bindings, ProxyGroupObject } from "../../platform/bindings.ts";

interface ProxyGroupClientOptions {
  readonly config: Pick<GatewayConfig, "revision">;
  readonly namespace: Bindings["PROXY_GROUP"];
  readonly context?: HealthExecutionContext | undefined;
  readonly requestId?: string | undefined;
}

/** One request owns this client and its RPC stub; no I/O is shared across requests. */
export class ProxyGroupClient {
  private snapshot: ProxyGroupSnapshot | undefined;
  private stub: ProxyGroupObject | undefined;

  constructor(
    private readonly group: ProxyGroupConfig,
    private readonly owner: ProxyOwner,
    private readonly options: ProxyGroupClientOptions,
  ) {}

  private getStub(): ProxyGroupObject {
    this.stub ??= this.options.namespace.getByName(this.group.id);
    return this.stub;
  }

  async select(
    exclude: readonly string[],
    signal: AbortSignal,
  ): Promise<ProxyLease> {
    try {
      this.snapshot ??= await abortable(
        proxyGroupSnapshot(this.options.config, this.group),
        signal,
      );
      signal.throwIfAborted();
      const result = proxySelectionSchema.parse(
        await abortable<unknown>(
          this.getStub().select({
            group: this.snapshot,
            owner: this.owner,
            exclude,
          }),
          signal,
        ),
      );
      signal.throwIfAborted();
      if (result.status !== "selected") {
        throw new ProxyUnavailableError(
          result.status === "unavailable"
            ? "proxy_group_unavailable"
            : "proxy_state_unavailable",
        );
      }
      return result.lease;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProxyUnavailableError) {
        throw error;
      }
      throw new ProxyUnavailableError("proxy_state_unavailable", {
        cause: error,
      });
    }
  }

  /** Fallback must await this result even when the write is also registered with waitUntil. */
  observe(
    lease: ProxyLease,
    outcome: ProxyOutcome["outcome"],
    eventId: string,
  ): Promise<boolean> {
    const event: ProxyOutcome = {
      lease,
      outcome,
      event_id: eventId,
      observed_at: Date.now(),
    };
    const pending = this.writeObservation(event);
    this.options.context?.waitUntil?.(pending);
    return pending;
  }

  private async writeObservation(event: ProxyOutcome): Promise<boolean> {
    try {
      await this.getStub().observe(event);
      return true;
    } catch {
      logWarn("proxy.health_update.failed", {
        request_id: this.options.requestId,
        group_id: this.group.id,
        proxy_id: event.lease.proxy_id,
      });
      return false;
    }
  }
}
