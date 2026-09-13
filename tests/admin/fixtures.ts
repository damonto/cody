import type { GatewayConfig } from "../../src/config/types.ts";
import { RequestMeter } from "../../src/telemetry/meter.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";

export function config(): GatewayConfig {
  return {
    services: [
      {
        id: "provider",
        base_url: "https://upstream.example/v1",
        keys: [
          {
            id: "primary",
            api_key: "test-upstream-secret",
            priority: 100,
            disabled: false,
          },
        ],
        models: ["real-model"],
        priority: 100,
        disabled: false,
        supports_websocket: true,
        supports_web_search: false,
        supports_context_management: false,
      },
    ],
    api_keys: [
      { id: "client", api_key: "test-client-secret", services: ["provider"] },
    ],
    model_routes: { alias: { model: "real-model" } },
    web_search: { mode: "proxy" },
    reporting: { time_zone: "Asia/Shanghai", retention_days: 120 },
    model_policies: [
      {
        service_id: "provider",
        model: "real-model",
        context_window: 1_000_000,
        pricing: {
          currency: "USD",
          tiers: [
            {
              up_to_input_tokens: null,
              input: "3",
              output: "15",
              cache_read: "0.3",
              cache_write: "3.75",
            },
          ],
        },
      },
    ],
  };
}
export function usage(id: string, at: number, currency = "USD"): UsageEvent {
  let now = at;
  const meter = new RequestMeter({
    requestId: id,
    endpoint: "responses",
    method: "POST",
    protocol: "openai",
    now: () => now,
    sink: { send: async () => {} },
  });
  const snapshot = config();
  snapshot.revision = 1;
  snapshot.model_policies![0].pricing!.currency = currency;
  meter.configure(snapshot);
  meter.authenticate("client");
  meter.requestedModel("alias");
  meter.select({
    serviceId: "provider",
    keyId: "primary",
    model: "real-model",
  });
  meter.recordAttempts([{ attempt: 1, status: 200, duration_ms: 100 }]);
  now += 100;
  meter.observe({ type: "response.created" });
  now += 150;
  meter.observe({
    type: "response.output_text.delta",
    delta: "private completion content",
  });
  now += 1000;
  meter.observe({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 25 },
      },
    },
  });
  return meter.finish("success", 200);
}
