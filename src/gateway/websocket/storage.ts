import { emptyCost } from "../../billing/calculate.ts";
import type { UsageEvent } from "../../telemetry/types.ts";
import { parseUsageEvent } from "../../telemetry/schema.ts";

const SESSION_KEY = "session";
const CHECKPOINT_PREFIX = "usage:";
const OUTBOX_PREFIX = "usage-outbox:";
const RETRY_DELAY_MS = 10_000;

export type SessionPhase =
  "awaiting_first_frame" | "routing" | "connecting" | "open" | "closed";

export const LIVE_PHASES: readonly SessionPhase[] = [
  "awaiting_first_frame",
  "routing",
  "connecting",
  "open",
];

export interface StoredWebSocketSession {
  version: 2;
  phase: SessionPhase;
  request_id: string;
  started_at: number;
  first_frame_deadline: number;
  incoming_search: string;
  forwarded_headers: [string, string][];
  client_api_key_digest: string;
  header_session_id?: string;
  current_session_id?: string;
  selected_provider_id?: string;
  selected_credential_id?: string;
  active_response: boolean;
  response_outcome_recorded: boolean;
  context_management?: boolean;
}

export interface StateTransition {
  previous: StoredWebSocketSession;
  next: StoredWebSocketSession;
}

/** Coordinates session state and usage recovery, which share one DO alarm. */
export class WebSocketStorage {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  loadSession(): Promise<StoredWebSocketSession | undefined> {
    return this.storage.get<StoredWebSocketSession>(SESSION_KEY);
  }

  createSession(state: StoredWebSocketSession): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      if ((await transaction.get(SESSION_KEY)) !== undefined) return false;
      await transaction.put(SESSION_KEY, state);
      await this.updateAlarm(transaction);
      return true;
    });
  }

  transition(
    expectedPhases: readonly SessionPhase[],
    mutate: (state: StoredWebSocketSession) => StoredWebSocketSession,
  ): Promise<StateTransition | undefined> {
    return this.storage.transaction(async (transaction) => {
      const current =
        await transaction.get<StoredWebSocketSession>(SESSION_KEY);
      if (!current || !expectedPhases.includes(current.phase)) return undefined;
      const next = mutate(current);
      if (current.phase === "closed" && next.phase !== "closed")
        return undefined;
      await transaction.put(SESSION_KEY, next);
      await this.updateAlarm(transaction);
      return { previous: current, next };
    });
  }

  clearSession(): Promise<void> {
    return this.storage.transaction(async (transaction) => {
      await transaction.delete(SESSION_KEY);
      await this.updateAlarm(transaction);
    });
  }

  checkpoint(event: UsageEvent): Promise<void> {
    return this.storage.put(`${CHECKPOINT_PREFIX}${event.request_id}`, event);
  }

  finish(event: UsageEvent): Promise<void> {
    return this.storage.transaction(async (transaction) => {
      // The exact terminal record and its wake-up must survive together.
      await transaction.put(`${OUTBOX_PREFIX}${event.request_id}`, event);
      await transaction.delete(`${CHECKPOINT_PREFIX}${event.request_id}`);
      await this.updateAlarm(transaction);
    });
  }

  async pendingUsage(): Promise<Map<string, UsageEvent>> {
    const records = await this.storage.list<unknown>({
      prefix: OUTBOX_PREFIX,
      limit: 64,
    });
    const pending = new Map<string, UsageEvent>();
    const ignored: string[] = [];
    for (const [key, value] of records) {
      const event = parseUsageEvent(value);
      if (event === null) ignored.push(key);
      else pending.set(key, event);
    }
    if (ignored.length > 0) {
      await this.storage.transaction(async (transaction) => {
        await transaction.delete(ignored);
        await this.updateAlarm(transaction);
      });
    }
    return pending;
  }

  acknowledgeUsage(requestId: string): Promise<void> {
    return this.storage.transaction(async (transaction) => {
      await transaction.delete(`${OUTBOX_PREFIX}${requestId}`);
      await this.updateAlarm(transaction);
    });
  }

  recoverUsage(): Promise<void> {
    return this.storage.transaction(async (transaction) => {
      const pending = await transaction.list<unknown>({
        prefix: CHECKPOINT_PREFIX,
      });
      const now = this.now();
      for (const [key, value] of pending) {
        const event = parseUsageEvent(value);
        if (event === null) {
          await transaction.delete(key);
          continue;
        }
        const ended: UsageEvent =
          event.phase === "finished"
            ? event
            : {
                ...event,
                sequence: 2,
                phase: "finished",
                outcome: "incomplete",
                finished_at: now,
                duration_ms: Math.max(0, now - event.started_at),
                observation_issue: "websocket_instance_restarted",
                billing: {
                  ...emptyCost("unknown"),
                  currency: event.billing.currency,
                },
              };
        await transaction.put(`${OUTBOX_PREFIX}${event.request_id}`, ended);
        await transaction.delete(key);
      }
      await this.updateAlarm(transaction);
    });
  }

  scheduleAlarm(): Promise<void> {
    return this.storage.transaction((transaction) =>
      this.updateAlarm(transaction),
    );
  }

  private async updateAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const session = await transaction.get<StoredWebSocketSession>(SESSION_KEY);
    const current = await transaction.getAlarm();
    let next =
      session?.phase === "awaiting_first_frame"
        ? session.first_frame_deadline
        : Infinity;
    const pending = await transaction.list({ prefix: OUTBOX_PREFIX, limit: 1 });
    if (pending.size) {
      // New traffic must never postpone recovery of an older record. During an
      // alarm invocation getAlarm() is null, so a failed delivery gets a new retry.
      next = Math.min(next, current ?? Infinity, this.now() + RETRY_DELAY_MS);
    }
    if (!Number.isFinite(next)) {
      if (current !== null) await transaction.deleteAlarm();
    } else if (next !== current) {
      await transaction.setAlarm(next);
    }
  }
}
