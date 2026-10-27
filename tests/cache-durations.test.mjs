import assert from "node:assert/strict";
import test from "node:test";
import { UsageAccumulator } from "../src/telemetry/usage.ts";
import { parseUsageEvent } from "../src/telemetry/schema.ts";
import { calculateCost } from "../src/billing/calculate.ts";
import { previewSchema } from "../src/admin/schema.ts";
import { RequestMeter } from "../src/telemetry/meter.ts";
import { usage as eventFixture } from "./admin/fixtures.ts";

const price = {
  provider_id: "provider",
  model: "model",
  pricing: {
    currency: "USD",
    tiers: [
      {
        up_to_input_tokens: null,
        input: "1",
        output: "1",
        cache_read: "0.1",
        cache_write: "1.25",
        cache_write_30m: "1.25",
        cache_write_12h: "2.5",
      },
    ],
  },
};
function wire(details = {}, input = {}) {
  return {
    input_tokens: 12000,
    output_tokens: 0,
    input_tokens_details: {
      cached_tokens: 4000,
      cache_write_tokens: 7000,
      cache_write_tokens_details: {
        ttl_30m_tokens: 3000,
        ttl_12h_tokens: 4000,
        ...details,
      },
      ...input,
    },
  };
}
function normalize(value, policy = price) {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add(value);
  return accumulator.snapshot(policy);
}

test("OpenAI mixed lifetimes use disjoint writes and the documented $0.01515 input cost", () => {
  const usage = normalize(wire());
  assert.equal(usage.status, "reported");
  assert.equal(usage.tokens.uncached_input_tokens, 1000);
  assert.equal(usage.tokens.cache_write_30m_tokens, 3000);
  assert.equal(usage.tokens.cache_write_12h_tokens, 4000);
  assert.equal(usage.tokens.cache_write_5m_tokens, null);
  const cost = calculateCost(usage.tokens, price);
  assert.equal(cost.status, "complete");
  assert.equal(cost.total_nano, 15_150_000);
  const fallback = structuredClone(price);
  delete fallback.pricing.tiers[0].cache_write_12h;
  assert.equal(
    calculateCost(usage.tokens, fallback).cache_write_nano,
    8_750_000,
  );
  fallback.pricing.tiers[0].cache_write_30m = "0";
  fallback.pricing.tiers[0].cache_write_12h = "0";
  assert.equal(calculateCost(usage.tokens, fallback).cache_write_nano, 0);
});

test("TTL details derive only absent totals and validate parent/modality contradictions", () => {
  const absent = wire();
  delete absent.input_tokens_details.cache_write_tokens;
  assert.equal(normalize(absent).tokens.cache_write_tokens, 7000);
  assert.equal(normalize(absent).tokens.uncached_input_tokens, 1000);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "7000"]) {
    assert.equal(
      normalize(wire({}, { cache_write_tokens: invalid })).tokens
        .cache_write_tokens,
      null,
    );
  }
  for (const bad of [
    wire({ ttl_12h_tokens: -1 }),
    wire({ ttl_12h_tokens: 1.2 }),
    wire({ ttl_12h_tokens: 5000 }),
    wire({ ttl_30m_tokens: Number.MAX_SAFE_INTEGER, ttl_12h_tokens: 1 }),
    wire({ ttl_30m_tokens: 8000, ttl_12h_tokens: null }),
  ]) {
    assert.equal(normalize(bad).status, "invalid");
  }
  absent.input_tokens_details.cache_write_tokens_details.text_tokens = 6000;
  absent.input_tokens_details.cache_write_tokens_details.image_tokens = 0;
  assert.equal(normalize(absent).status, "invalid");
});

test("unknown durations remain unknown and new prices prevent free-write inference", () => {
  const value = wire({}, { cache_write_tokens_details: undefined });
  const usage = normalize(value);
  assert.equal(usage.tokens.cache_write_30m_tokens, null);
  assert.equal(calculateCost(usage.tokens, price).cache_write_nano, null);
  delete value.input_tokens_details.cache_write_tokens;
  const free = structuredClone(price);
  free.pricing.tiers[0].cache_write = "0";
  assert.equal(normalize(value, free).tokens.cache_write_tokens, null);
  free.pricing.tiers[0].cache_write_30m = "0";
  free.pricing.tiers[0].cache_write_12h = "0";
  assert.equal(normalize(value, free).tokens.cache_write_tokens, 0);
  const zero = normalize(
    wire({ ttl_30m_tokens: 0, ttl_12h_tokens: 0 }, { cache_write_tokens: 0 }),
  );
  assert.equal(calculateCost(zero.tokens, price).cache_write_nano, 0);
});

test("Chat aliases, whitelist, cumulative updates and isolated snapshots retain both lifetimes", () => {
  const accumulator = new UsageAccumulator("openai");
  const value = wire({ prompt: "private", text_tokens: 7000, image_tokens: 0 });
  accumulator.add({
    prompt_tokens: value.input_tokens,
    completion_tokens: 0,
    prompt_tokens_details: value.input_tokens_details,
    content: "private",
  });
  const first = accumulator.snapshot();
  accumulator.add({
    prompt_tokens_details: {
      cache_write_tokens: 7000,
      cache_write_tokens_details: {
        ttl_30m_tokens: 4000,
        ttl_12h_tokens: 3000,
      },
    },
  });
  assert.equal(first.tokens.cache_write_30m_tokens, 3000);
  assert.equal(accumulator.snapshot().tokens.cache_write_30m_tokens, 4000);
  assert.equal(JSON.stringify(first.raw).includes("private"), false);
  assert.equal(first.tokens.image_cache_write_tokens, 0);
});

test("image writes preserve known charges without guessing duration allocations", () => {
  const policy = structuredClone(price);
  policy.pricing.tiers[0].image_cache_write = "4";
  const mixed = normalize(
    wire({ image_tokens: 1000, text_tokens: 6000 }, { image_tokens: 1000 }),
  );
  const cost = calculateCost(mixed.tokens, policy);
  assert.equal(cost.image_cache_write_nano, 4_000_000);
  assert.equal(cost.cache_write_nano, null);
  const single = normalize(
    wire(
      {
        ttl_30m_tokens: 7000,
        ttl_12h_tokens: 0,
        image_tokens: 1000,
        text_tokens: 6000,
      },
      { image_tokens: 1000 },
    ),
  );
  assert.equal(
    calculateCost(single.tokens, policy).cache_write_nano,
    7_500_000,
  );
});

test("preview rejects mixed formats and old v2 events retain unknown new durations", () => {
  const usage = normalize(wire()).tokens;
  const { uncached_input_tokens: _, ...input } = usage;
  assert.equal(previewSchema.safeParse({ price, usage: input }).success, true);
  assert.equal(
    previewSchema.safeParse({
      price,
      usage: { ...input, cache_write_5m_tokens: 7000 },
    }).success,
    false,
  );
  const event = eventFixture("old", 1000);
  delete event.usage.tokens.cache_write_30m_tokens;
  delete event.usage.tokens.cache_write_12h_tokens;
  assert.equal(
    parseUsageEvent(event).usage.tokens.cache_write_30m_tokens,
    null,
  );
});

for (const previousKnown of [true, false]) {
  test(`Claude retry durations stay unknown when an earlier attempt ${previousKnown ? "omits durations" : "omits usage"}`, async () => {
    const policy = structuredClone(price);
    const tier = policy.pricing.tiers[0];
    tier.cache_write_5m = tier.cache_write_30m;
    tier.cache_write_1h = tier.cache_write_12h;
    delete tier.cache_write_30m;
    delete tier.cache_write_12h;
    const current = {
      input_tokens: 1000,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 7000,
      cache_creation: {
        ephemeral_5m_input_tokens: 3000,
        ephemeral_1h_input_tokens: 4000,
      },
      output_tokens: 0,
    };
    const accumulator = new UsageAccumulator("anthropic");
    accumulator.add({ ...current, cache_creation: undefined });
    const events = [];
    const meter = new RequestMeter({
      requestId: `claude-retry-${previousKnown}`,
      endpoint: "messages",
      method: "POST",
      protocol: "anthropic",
      sink: { send: async (event) => events.push(event) },
    });
    meter.configure({ revision: 1, providers: [], model_prices: [policy] });
    meter.select({
      providerId: policy.provider_id,
      credentialId: "key",
      model: policy.model,
    });
    meter.recordAttempts([
      {
        attempt: 1,
        status: 503,
        duration_ms: 1,
        usage: previousKnown ? accumulator.snapshot(policy) : null,
      },
      { attempt: 2, status: 200, duration_ms: 1 },
    ]);
    await meter.response(Response.json({ usage: current })).text();
    await meter.drain();
    const event = events.at(-1);
    assert.equal(event.attempts[1].billing.total_nano, 15_150_000);
    assert.equal(event.usage.tokens.cache_write_5m_tokens, null);
    assert.equal(event.usage.tokens.cache_write_1h_tokens, null);
    assert.equal(event.billing.status, "partial");
  });
}

test("duration overrides retain per-bucket rounding and ignore the other format's prices", () => {
  const policy = structuredClone(price);
  const tier = policy.pricing.tiers[0];
  Object.assign(tier, {
    cache_write: "0.000001",
    cache_write_30m: "0.000001",
    cache_write_12h: "0.000001",
    cache_write_5m: "100",
    cache_write_1h: "100",
  });
  const usage = normalize(
    wire(
      { ttl_30m_tokens: 500, ttl_12h_tokens: 500 },
      { cache_write_tokens: 1000 },
    ),
  );
  assert.equal(calculateCost(usage.tokens, policy).cache_write_nano, 2);
  delete tier.cache_write_30m;
  delete tier.cache_write_12h;
  assert.equal(calculateCost(usage.tokens, policy).cache_write_nano, 1);
});

for (const transport of ["json", "sse", "websocket"]) {
  for (const previousKnown of [true, false]) {
    test(`${transport}: retry lifetime counts preserve ${previousKnown ? "complete" : "unknown"} usage`, async () => {
      const events = [];
      const meter = new RequestMeter({
        requestId: `${transport}-${previousKnown}`,
        endpoint: "responses",
        method: transport === "websocket" ? "WS" : "POST",
        protocol: "openai",
        websocket: transport === "websocket",
        sink: { send: async (event) => events.push(event) },
      });
      meter.configure({ revision: 1, providers: [], model_prices: [price] });
      meter.select({
        providerId: price.provider_id,
        credentialId: "key",
        model: price.model,
      });
      const previous = previousKnown
        ? wire()
        : wire({}, { cache_write_tokens_details: undefined });
      meter.recordAttempts([
        { attempt: 1, status: 503, duration_ms: 1, usage: normalize(previous) },
        { attempt: 2, status: 200, duration_ms: 1 },
      ]);
      const response = { id: "response", usage: wire() };
      const frame = { type: "response.completed", response };
      if (transport === "websocket") {
        meter.observe(frame);
        meter.finish("success", 200);
      } else {
        const source =
          transport === "json"
            ? JSON.stringify(response)
            : `data: ${JSON.stringify(frame)}\n\n`;
        assert.equal(
          await meter
            .response(
              new Response(source, {
                headers: {
                  "content-type":
                    transport === "json"
                      ? "application/json"
                      : "text/event-stream",
                },
              }),
            )
            .text(),
          source,
        );
      }
      await meter.drain();
      const event = events.at(-1);
      assert.equal(event.usage.tokens.cache_write_tokens, 14000);
      assert.equal(
        event.usage.tokens.cache_write_30m_tokens,
        previousKnown ? 6000 : null,
      );
      assert.equal(
        event.usage.tokens.cache_write_12h_tokens,
        previousKnown ? 8000 : null,
      );
      assert.equal(
        event.billing.status,
        previousKnown ? "complete" : "partial",
      );
      assert.equal(event.attempts[1].billing.total_nano, 15_150_000);
      if (previousKnown) assert.equal(event.billing.total_nano, 30_300_000);
    });
  }
}
