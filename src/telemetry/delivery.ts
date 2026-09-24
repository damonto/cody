import type { UsageSink } from "./meter.ts";
import type { Bindings } from "../platform/bindings.ts";

type UsageSinkBindings = Required<Pick<Bindings, "USAGE_OUTBOX">>;

/** UUID prefixes distribute journals across 256 independently scheduled objects. */
export function durableUsageSink(
  env: UsageSinkBindings,
  requestId: string,
): UsageSink {
  const shard = requestId.slice(0, 2);
  return {
    async send(event): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        try {
          // A failed RPC can invalidate a stub; obtain a new one for each retry.
          await env.USAGE_OUTBOX.getByName(shard).enqueue(event);
          return;
        } catch (error) {
          if (attempt === 2) {
            throw error;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * 2 ** attempt),
          );
        }
      }
    },
  };
}

/** WebSocket final events are already journaled by WebSocketUsage. */
export function webSocketUsageSink(
  env: UsageSinkBindings & Pick<Bindings, "USAGE_QUEUE">,
): UsageSink {
  return {
    async send(event): Promise<void> {
      if (event.phase === "finished") {
        await env.USAGE_QUEUE.send(event);
      } else {
        await durableUsageSink(env, event.request_id).send(event);
      }
    },
  };
}
