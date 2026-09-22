import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelPolicies,
  parseRate,
  parseReporting,
} from "../src/billing/config.ts";
import { calculateCost, tokenCost } from "../src/billing/calculate.ts";
import { UsageAccumulator } from "../src/telemetry/usage.ts";

const tier = (upper, input = "3", output = "15") => ({
  up_to_input_tokens: upper,
  input,
  output,
  cache_write: "3.75",
  cache_read: "0.30",
});
const policy = {
  provider_id: "a",
  model: "real-model",
  context_window: 1_000_000,
  pricing: {
    currency: "USD",
    tiers: [
      tier(200_000),
      { ...tier(null, "6", "30"), cache_write: "7.50", cache_read: "0.60" },
    ],
  },
};

const noWriteChargePolicy = {
  provider_id: "a",
  model: "gemini-3.8-flash",
  pricing: {
    currency: "USD",
    tiers: [
      {
        up_to_input_tokens: null,
        input: "0.75",
        output: "3.75",
        cache_write: "0",
        cache_read: "0.075",
      },
    ],
  },
};

function openai(input = 220_000, cached = 140_000, write = 20_000) {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
    output_tokens: 4000,
    output_tokens_details: { reasoning_tokens: 1000 },
  });
  return accumulator.snapshot();
}

test("pricing uses total context including cache and charges reasoning once", () => {
  const usage = openai();
  assert.equal(usage.tokens.uncached_input_tokens, 60_000);
  const result = calculateCost(usage.tokens, policy, "revision-1");
  assert.equal(result.tier_index, 1);
  assert.equal(result.total_nano, 714_000_000);
  assert.equal(result.output_nano, 120_000_000);
  assert.equal(result.status, "complete");
  assert.equal(result.price_version, "revision-1");
});

test("tier thresholds are inclusive and switching reprices the entire request", () => {
  for (const [input, index, cost] of [
    [199999, 0, 599_997_000],
    [200000, 0, 600_000_000],
    [200001, 1, 1_200_006_000],
  ]) {
    const result = calculateCost(openai(input, 0, 0).tokens, policy);
    assert.equal(result.tier_index, index);
    assert.equal(result.input_nano, cost);
  }
});

test("decimal money uses integer nanounits with explicit rounding", () => {
  assert.equal(tokenCost(1_000_000, "0.000001"), 1000);
  assert.equal(tokenCost(1500, "0.000001"), 2);
  assert.equal(tokenCost(null, "3"), null);
  assert.equal(tokenCost(5000, "0"), 0);
  for (const invalid of ["-1", "1e-3", "NaN", "0.0000001", 3])
    assert.throws(() => parseRate(invalid));
});

test("Anthropic cumulative events merge rather than add output and cache counters", () => {
  const accumulator = new UsageAccumulator("anthropic");
  accumulator.add({
    input_tokens: 60000,
    output_tokens: 1,
    cache_creation_input_tokens: 20000,
    cache_read_input_tokens: 140000,
    cache_creation: {
      ephemeral_5m_input_tokens: 15000,
      ephemeral_1h_input_tokens: 5000,
    },
    content: "never retain this",
  });
  accumulator.add({ output_tokens: 1000 });
  accumulator.add({ output_tokens: 4000 });
  const usage = accumulator.snapshot();
  assert.equal(usage.tokens.input_tokens, 220_000);
  assert.equal(usage.tokens.output_tokens, 4000);
  assert.equal(usage.tokens.reasoning_tokens, null);
  assert.equal(Object.hasOwn(usage.raw, "content"), false);
  const ttlPolicy = structuredClone(policy);
  ttlPolicy.pricing.tiers[1].cache_write_5m = "7.50";
  ttlPolicy.pricing.tiers[1].cache_write_1h = "12";
  assert.equal(calculateCost(usage.tokens, ttlPolicy).total_nano, 736_500_000);
});

test("missing counters and unknown cache TTLs never become free usage", () => {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    input_tokens: 1000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 500 },
  });
  const usage = accumulator.snapshot(policy);
  assert.equal(usage.tokens.cache_write_tokens, null);
  assert.equal(usage.tokens.uncached_input_tokens, null);
  assert.equal(usage.status, "partial");
  assert.equal(calculateCost(usage.tokens, policy).status, "partial");
  const ttlPolicy = structuredClone(policy);
  ttlPolicy.pricing.tiers[1].cache_write_1h = "12";
  assert.equal(
    calculateCost(openai().tokens, ttlPolicy).cache_write_nano,
    null,
  );
});

for (const dialect of ["responses", "chat/completions"]) {
  test(`${dialect} usage without separately charged cache writes includes input cost`, () => {
    for (const [cached, expectedCost] of [
      [0, 10_845_750],
      [10_000, 4_095_750],
    ]) {
      const raw =
        dialect === "responses"
          ? {
              input_tokens: 14_436,
              output_tokens: 5,
              total_tokens: 14_441,
              input_tokens_details: { cached_tokens: cached },
            }
          : {
              prompt_tokens: 14_436,
              completion_tokens: 5,
              total_tokens: 14_441,
              prompt_tokens_details: { cached_tokens: cached },
            };
      const accumulator = new UsageAccumulator("openai");
      accumulator.add(raw);
      const usage = accumulator.snapshot(noWriteChargePolicy);
      assert.equal(usage.status, "reported");
      assert.equal(usage.tokens.uncached_input_tokens, 14_436 - cached);
      assert.equal(usage.tokens.cache_write_tokens, 0);
      assert.equal(usage.tokens.reasoning_tokens, null);
      assert.deepEqual(usage.raw, raw);
      const cost = calculateCost(usage.tokens, noWriteChargePolicy);
      assert.equal(cost.status, "complete");
      assert.equal(cost.total_nano, expectedCost);
      assert.equal(cost.cache_write_nano, 0);
    }
  });
}

test("omitted cache writes use the request's selected tier and all cache write rates", () => {
  const tiered = structuredClone(policy);
  tiered.pricing.tiers[0].cache_write = "0.000000";
  for (const [input, expected] of [
    [199_999, "reported"],
    [200_000, "reported"],
    [200_001, "partial"],
  ]) {
    const accumulator = new UsageAccumulator("openai");
    accumulator.add({
      input_tokens: input,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
    });
    assert.equal(accumulator.snapshot(tiered).status, expected);
  }
  for (const field of ["cache_write", "cache_write_5m", "cache_write_1h"]) {
    const withWriteCharge = structuredClone(noWriteChargePolicy);
    withWriteCharge.pricing.tiers[0][field] = "0.000001";
    const accumulator = new UsageAccumulator("openai");
    accumulator.add({
      input_tokens: 1000,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
    });
    assert.equal(accumulator.snapshot(withWriteCharge).status, "partial");
  }
});

test("zero cache write prices do not hide missing, invalid, or explicit counters", () => {
  const raw = {
    input_tokens: 1000,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 100 },
  };
  const accumulator = new UsageAccumulator("openai");
  assert.equal(accumulator.snapshot(noWriteChargePolicy).status, "missing");
  accumulator.add(raw);
  assert.equal(accumulator.snapshot().status, "partial");
  assert.equal(
    accumulator.snapshot({ provider_id: "a", model: "unpriced" }).status,
    "partial",
  );
  for (const value of [null, -1, "0", 0.5]) {
    accumulator.add({ input_tokens_details: { cache_write_tokens: value } });
    const usage = accumulator.snapshot(noWriteChargePolicy);
    assert.equal(usage.status, "partial");
    assert.equal(usage.tokens.cache_write_tokens, null);
    assert.equal(usage.tokens.uncached_input_tokens, null);
  }
  accumulator.add({ input_tokens_details: { cache_write_tokens: 250 } });
  const explicit = accumulator.snapshot(noWriteChargePolicy);
  assert.equal(explicit.status, "reported");
  assert.equal(explicit.tokens.cache_write_tokens, 250);
  assert.equal(explicit.tokens.uncached_input_tokens, 650);

  for (const incomplete of [
    { input_tokens: 1000, output_tokens: 5 },
    { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 } },
    { output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
  ]) {
    const missing = new UsageAccumulator("openai");
    missing.add(incomplete);
    assert.equal(missing.snapshot(noWriteChargePolicy).status, "partial");
  }

  const anthropic = new UsageAccumulator("anthropic");
  anthropic.add({
    input_tokens: 1000,
    output_tokens: 5,
    cache_read_input_tokens: 0,
  });
  assert.equal(anthropic.snapshot(noWriteChargePolicy).status, "partial");
  assert.equal(
    anthropic.snapshot(noWriteChargePolicy).tokens.cache_write_tokens,
    null,
  );
});

test("inferred cache writes do not alter cumulative usage or conceal contradictions", () => {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    input_tokens: 1000,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 100 },
  });
  const first = accumulator.snapshot(noWriteChargePolicy);
  assert.equal(first.tokens.uncached_input_tokens, 900);
  assert.equal(first.tokens.cache_write_tokens, 0);
  assert.equal(accumulator.snapshot().tokens.cache_write_tokens, null);
  accumulator.add({ input_tokens_details: { cache_write_tokens: 250 } });
  const updated = accumulator.snapshot(noWriteChargePolicy);
  assert.equal(updated.tokens.uncached_input_tokens, 650);
  assert.equal(updated.tokens.cache_write_tokens, 250);
  assert.equal(first.tokens.cache_write_tokens, 0);

  const invalid = new UsageAccumulator("openai");
  invalid.add({
    input_tokens: 1000,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 1001 },
  });
  assert.equal(invalid.snapshot(noWriteChargePolicy).status, "invalid");
});

test("policies are unique per provider and real model, with sorted complete tiers", () => {
  const providers = [{ id: "a", models: ["real-model"] }];
  assert.deepEqual(parseModelPolicies([policy], providers), [policy]);
  assert.throws(
    () => parseModelPolicies([policy, policy], providers),
    /duplicates/,
  );
  assert.throws(
    () => parseModelPolicies([{ ...policy, model: "client-alias" }], providers),
    /one of its models/,
  );
  const invalid = structuredClone(policy);
  invalid.pricing.tiers[1].up_to_input_tokens = 300000;
  assert.throws(() => parseModelPolicies([invalid], providers), /final tier/);
  invalid.pricing.tiers = [tier(200000), tier(100000), tier(null)];
  assert.throws(
    () => parseModelPolicies([invalid], providers),
    /increase strictly/,
  );
  assert.throws(
    () => parseReporting({ time_zone: "Mars", retention_days: 120 }),
    /time zone/,
  );
  assert.throws(
    () => parseReporting({ time_zone: "Asia/Shanghai", retention_days: 90 }),
    /100 and 730/,
  );
});

test("contradictory usage is identified instead of silently clamped", () => {
  assert.equal(openai(100, 90, 30).status, "invalid");
});
