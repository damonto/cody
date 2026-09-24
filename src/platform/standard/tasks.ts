/**
 * Process-wide registry of background work (health writes, usage delivery,
 * object follow-ups) so a Node server can drain it on shutdown and Vercel can
 * hand it to the platform's `waitUntil`.
 */
import { errorMessage, logWarn } from "../../shared/log.ts";

export interface BackgroundTasks {
  track(promise: Promise<unknown>): void;
  /** Resolves once every tracked task has settled. */
  drain(): Promise<void>;
  readonly size: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}

export class TaskTracker implements BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly forward?: (promise: Promise<unknown>) => void) {}

  track(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => undefined,
      (error: unknown) => {
        logWarn("background.task.failed", { error: errorMessage(error) });
      },
    );
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
    this.forward?.(settled);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  get size(): number {
    return this.pending.size;
  }

  /** A per-request `ExecutionContext` whose work outlives the response. */
  executionContext(): ExecutionContextLike {
    return {
      waitUntil: (promise) => this.track(promise),
      passThroughOnException: () => {},
      props: {},
    };
  }
}
