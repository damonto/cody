import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelPrices,
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
  assert.deepEqual(parseModelPrices([policy], providers), [policy]);
  assert.throws(
    () => parseModelPrices([policy, policy], providers),
    /duplicates/,
  );
  assert.throws(
    () => parseModelPrices([{ ...policy, model: "client-alias" }], providers),
    /one of its models/,
  );
  const invalid = structuredClone(policy);
  invalid.pricing.tiers[1].up_to_input_tokens = 300000;
  assert.throws(() => parseModelPrices([invalid], providers), /final tier/);
  invalid.pricing.tiers = [tier(200000), tier(100000), tier(null)];
  assert.throws(
    () => parseModelPrices([invalid], providers),
    /increase strictly/,
  );
  assert.throws(
    () => parseReporting({ time_zone: "Mars", retention_days: 120 }),
    /time zone/,
  );
  for (const retention_days of [30, 90, 730]) {
    const reporting = { time_zone: "Asia/Shanghai", retention_days };
    assert.deepEqual(parseReporting(reporting), reporting);
  }
  for (const retention_days of [29, 731]) {
    assert.throws(
      () => parseReporting({ time_zone: "Asia/Shanghai", retention_days }),
      /30 and 730/,
    );
  }
});

test("contradictory usage is identified instead of silently clamped", () => {
  assert.equal(openai(100, 90, 30).status, "invalid");
});

const imagePolicy = {
  provider_id: "a",
  model: "real-model",
  pricing: {
    currency: "USD",
    tiers: [
      {
        up_to_input_tokens: null,
        input: "2",
        output: "4",
        cache_read: "1",
        cache_write: "0",
        image_input: "8",
        image_output: "32",
        image_cache_read: "3",
      },
    ],
  },
};
function imageUsage(overrides = {}, endpoint) {
  const accumulator = new UsageAccumulator("openai", endpoint);
  accumulator.add({
    input_tokens: 100,
    output_tokens: 50,
    input_tokens_details: {
      image_tokens: 80,
      cached_tokens: 50,
      cache_write_tokens: 0,
      cached_tokens_details: { image_tokens: 40 },
    },
    output_tokens_details: { image_tokens: 30 },
    ...overrides,
  });
  return accumulator.snapshot(imagePolicy);
}

test("image input, output and cached images form disjoint charges", () => {
  const usage = imageUsage();
  assert.equal(usage.status, "reported");
  const cost = calculateCost(usage.tokens, imagePolicy);
  assert.equal(cost.input_nano, 20_000);
  assert.equal(cost.image_input_nano, 320_000);
  assert.equal(cost.output_nano, 80_000);
  assert.equal(cost.image_output_nano, 960_000);
  assert.equal(cost.cache_read_nano, 10_000);
  assert.equal(cost.image_cache_read_nano, 120_000);
  assert.equal(cost.total_nano, 1_510_000);
  assert.equal(cost.status, "complete");
});

test("image rates distinguish zero from inheritance and retain legacy rounding", () => {
  const price = structuredClone(imagePolicy);
  for (const field of ["image_input", "image_output", "image_cache_read"])
    price.pricing.tiers[0][field] = "0";
  assert.equal(calculateCost(imageUsage().tokens, price).total_nano, 110_000);
  for (const field of ["image_input", "image_output", "image_cache_read"])
    delete price.pricing.tiers[0][field];
  assert.equal(calculateCost(imageUsage().tokens, price).total_nano, 350_000);
  price.pricing.tiers[0].input = "0.000001";
  const tokens = {
    ...imageUsage().tokens,
    input_tokens: 1000,
    uncached_input_tokens: 1000,
    cache_read_tokens: 0,
    image_input_tokens: 500,
    image_cache_read_tokens: 0,
  };
  assert.equal(calculateCost(tokens, price).input_nano, 1);
  assert.equal(calculateCost(tokens, price).image_input_nano, 0);
});

test("missing image categories and ambiguous writes leave affected costs unknown", () => {
  for (const overrides of [
    { input_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 } },
    {
      input_tokens_details: {
        image_tokens: 80,
        cached_tokens: 50,
        cache_write_tokens: 0,
      },
    },
    {
      input_tokens_details: {
        image_tokens: 80,
        cached_tokens: 50,
        cache_write_tokens: 5,
        cached_tokens_details: { image_tokens: 40 },
      },
    },
  ]) {
    const cost = calculateCost(imageUsage(overrides).tokens, imagePolicy);
    assert.equal(cost.input_nano, null);
    assert.equal(cost.image_input_nano, null);
    assert.equal(cost.status, "partial");
  }
  const missingOutput = calculateCost(
    imageUsage({ output_tokens_details: {} }).tokens,
    imagePolicy,
  );
  assert.equal(missingOutput.output_nano, null);
  assert.equal(missingOutput.image_output_nano, null);
  assert.equal(missingOutput.total_nano, 470_000);
});

test("image counters validate subsets, distinguish absent and invalid, and infer zero totals", () => {
  for (const image_tokens of [
    -1,
    0.5,
    "80",
    null,
    101,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      imageUsage({ input_tokens_details: { image_tokens } }).status,
      "invalid",
    );
  }
  assert.equal(
    imageUsage({ output_tokens_details: { image_tokens: 51 } }).status,
    "invalid",
  );
  assert.equal(
    imageUsage({
      input_tokens_details: {
        image_tokens: 80,
        cached_tokens: 50,
        cached_tokens_details: { image_tokens: 20 },
      },
    }).status,
    "invalid",
  );
  const zero = imageUsage({
    input_tokens: 0,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: {},
  });
  assert.equal(zero.tokens.image_input_tokens, 0);
  assert.equal(zero.tokens.image_output_tokens, 0);
  assert.equal(zero.tokens.image_cache_read_tokens, 0);
  assert.equal(calculateCost(zero.tokens, imagePolicy).total_nano, 0);
  assert.equal(
    imageUsage({ output_tokens_details: {} }, "images/edits").tokens
      .image_output_tokens,
    50,
  );
  assert.equal(
    imageUsage(
      { output_tokens_details: { image_tokens: null } },
      "images/edits",
    ).status,
    "invalid",
  );
});

test("chat aliases and cumulative cached image details are retained without content", () => {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    prompt_tokens: 100,
    completion_tokens: 50,
    prompt_tokens_details: {
      image_tokens: 80,
      cached_tokens_details: {
        image_tokens: 40,
        text_tokens: 10,
        content: "secret",
      },
    },
    completion_tokens_details: { image_tokens: 30 },
  });
  const first = accumulator.snapshot(imagePolicy);
  assert.equal(first.tokens.cache_read_tokens, 50);
  assert.equal(first.tokens.image_cache_read_tokens, 40);
  assert.equal(calculateCost(first.tokens, imagePolicy).total_nano, 1_510_000);
  accumulator.add({
    prompt_tokens_details: { cached_tokens_details: { image_tokens: 45 } },
  });
  assert.equal(first.tokens.image_cache_read_tokens, 40);
  assert.equal(
    accumulator.snapshot(imagePolicy).tokens.image_cache_read_tokens,
    45,
  );
  assert.equal(JSON.stringify(first.raw).includes("secret"), false);
});

test("image pricing follows total-input tiers and enforces monetary precision", () => {
  const price = structuredClone(imagePolicy);
  price.pricing.tiers = [
    { ...price.pricing.tiers[0], up_to_input_tokens: 100 },
    { ...price.pricing.tiers[0], image_input: "16" },
  ];
  assert.equal(
    calculateCost(imageUsage().tokens, price).image_input_nano,
    320_000,
  );
  const above = imageUsage({ input_tokens: 101 }).tokens;
  assert.equal(calculateCost(above, price).image_input_nano, 640_000);
  const excessive = {
    ...imageUsage().tokens,
    input_tokens: Number.MAX_SAFE_INTEGER,
    uncached_input_tokens: Number.MAX_SAFE_INTEGER,
    cache_read_tokens: 0,
    image_cache_read_tokens: 0,
    image_input_tokens: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(() => calculateCost(excessive, price), /precision/);
  const providers = [{ id: "a", models: ["real-model"] }];
  assert.deepEqual(parseModelPrices([imagePolicy], providers), [imagePolicy]);
  for (const rate of ["-1", "1e-3", "0.0000001", 8]) {
    const invalid = structuredClone(imagePolicy);
    invalid.pricing.tiers[0].image_input = rate;
    assert.throws(() => parseModelPrices([invalid], providers));
  }
});

test("missing output totals retain independently known image output charges", () => {
  const usage = imageUsage({ output_tokens: undefined });
  assert.equal(usage.status, "partial");
  const cost = calculateCost(usage.tokens, imagePolicy);
  assert.equal(cost.output_nano, null);
  assert.equal(cost.image_output_nano, 960_000);
  assert.equal(cost.total_nano, 1_430_000);
  assert.equal(cost.status, "partial");
});

test("cached text and image subtotals cannot contradict their reported total", () => {
  for (const text_tokens of [-1, 0.5, "10", null, 11, 51]) {
    const usage = imageUsage({
      input_tokens_details: {
        image_tokens: 80,
        cached_tokens: 50,
        cache_write_tokens: 0,
        cached_tokens_details: { image_tokens: 40, text_tokens },
      },
    });
    assert.equal(usage.status, "invalid", String(text_tokens));
  }
  const valid = imageUsage({
    input_tokens_details: {
      image_tokens: 80,
      cached_tokens: 50,
      cache_write_tokens: 0,
      cached_tokens_details: { image_tokens: 40, text_tokens: 10 },
    },
  });
  assert.equal(valid.status, "reported");
});

test("zero uncached input needs no guessed image allocation", () => {
  const usage = imageUsage({
    input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
  });
  const cost = calculateCost(usage.tokens, imagePolicy);
  assert.equal(cost.input_nano, 0);
  assert.equal(cost.image_input_nano, 0);
  assert.equal(cost.cache_read_nano, null);
  assert.equal(cost.status, "partial");
});

const imageWritePolicy = structuredClone(imagePolicy);
imageWritePolicy.pricing.tiers[0].cache_write = "5";
imageWritePolicy.pricing.tiers[0].image_cache_write = "10";
function imageWriteUsage(overrides = {}, details = {}) {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    input_tokens: 100,
    output_tokens: 50,
    input_tokens_details: {
      image_tokens: 80,
      cached_tokens: 30,
      cache_write_tokens: 20,
      cached_tokens_details: { image_tokens: 20 },
      cache_write_tokens_details: { image_tokens: 15, text_tokens: 5 },
      ...details,
    },
    output_tokens_details: { image_tokens: 30 },
    ...overrides,
  });
  return accumulator.snapshot(imageWritePolicy);
}

test("image cache writes are excluded from both ordinary writes and uncached image input", () => {
  const usage = imageWriteUsage();
  assert.equal(usage.status, "reported");
  assert.equal(usage.tokens.image_cache_write_tokens, 15);
  const cost = calculateCost(usage.tokens, imageWritePolicy);
  assert.equal(cost.input_nano, 10_000);
  assert.equal(cost.image_input_nano, 360_000);
  assert.equal(cost.cache_write_nano, 25_000);
  assert.equal(cost.image_cache_write_nano, 150_000);
  assert.equal(cost.total_nano, 1_655_000);
  assert.equal(cost.status, "complete");
  const free = structuredClone(imageWritePolicy);
  free.pricing.tiers[0].image_cache_write = "0";
  assert.equal(calculateCost(usage.tokens, free).total_nano, 1_505_000);
  delete free.pricing.tiers[0].image_cache_write;
  assert.equal(calculateCost(usage.tokens, free).cache_write_nano, 100_000);
  assert.equal(calculateCost(usage.tokens, free).image_cache_write_nano, 0);
});

test("image write counters validate input overlap and cache subtotals", () => {
  for (const image_tokens of [-1, 0.5, null, "15", 21]) {
    assert.equal(
      imageWriteUsage({}, { cache_write_tokens_details: { image_tokens } })
        .status,
      "invalid",
    );
  }
  assert.equal(imageWriteUsage({}, { image_tokens: 30 }).status, "invalid");
  assert.equal(
    imageWriteUsage(
      {},
      { cache_write_tokens_details: { image_tokens: 15, text_tokens: 6 } },
    ).status,
    "invalid",
  );
  const partial = imageWriteUsage(
    {},
    { cache_write_tokens_details: undefined },
  );
  const cost = calculateCost(partial.tokens, imageWritePolicy);
  assert.equal(cost.image_cache_write_nano, null);
  assert.equal(cost.cache_write_nano, null);
  assert.equal(cost.image_input_nano, null);
  assert.equal(cost.status, "partial");
});

test("cache write detail totals and chat aliases are parsed without retaining content", () => {
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    prompt_tokens: 100,
    completion_tokens: 50,
    prompt_tokens_details: {
      image_tokens: 80,
      cached_tokens: 30,
      cached_tokens_details: { image_tokens: 20 },
      cache_write_tokens_details: {
        image_tokens: 15,
        text_tokens: 5,
        content: "private",
      },
    },
    completion_tokens_details: { image_tokens: 30 },
  });
  const first = accumulator.snapshot(imageWritePolicy);
  assert.equal(first.tokens.cache_write_tokens, 20);
  assert.equal(
    calculateCost(first.tokens, imageWritePolicy).total_nano,
    1_655_000,
  );
  accumulator.add({
    prompt_tokens_details: {
      cache_write_tokens_details: { image_tokens: 16, text_tokens: 4 },
    },
  });
  assert.equal(first.tokens.image_cache_write_tokens, 15);
  assert.equal(
    accumulator.snapshot(imageWritePolicy).tokens.image_cache_write_tokens,
    16,
  );
  assert.equal(JSON.stringify(first.raw).includes("private"), false);
});

test("a separately priced image write cannot be inferred as a free omitted write", () => {
  const price = structuredClone(noWriteChargePolicy);
  price.pricing.tiers[0].image_cache_write = "10";
  const accumulator = new UsageAccumulator("openai");
  accumulator.add({
    input_tokens: 100,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
  });
  assert.equal(accumulator.snapshot(price).tokens.cache_write_tokens, null);
  price.pricing.tiers[0].image_cache_write = "0";
  assert.equal(accumulator.snapshot(price).tokens.cache_write_tokens, 0);
});

test("image write pricing preserves TTL inheritance and never guesses mixed-duration text writes", () => {
  const price = structuredClone(imageWritePolicy);
  Object.assign(price.pricing.tiers[0], {
    cache_write_5m: "5",
    cache_write_1h: "10",
  });
  const tokens = {
    ...imageWriteUsage().tokens,
    cache_write_5m_tokens: 10,
    cache_write_1h_tokens: 10,
  };
  const mixed = calculateCost(tokens, price);
  assert.equal(mixed.image_cache_write_nano, 150_000);
  assert.equal(mixed.cache_write_nano, null);
  assert.equal(mixed.status, "partial");
  assert.equal(
    calculateCost(
      { ...tokens, cache_write_5m_tokens: 0, cache_write_1h_tokens: 20 },
      price,
    ).cache_write_nano,
    50_000,
  );
  assert.equal(
    calculateCost(
      { ...tokens, cache_write_5m_tokens: 20, cache_write_1h_tokens: 0 },
      price,
    ).cache_write_nano,
    25_000,
  );
  price.pricing.tiers[0].cache_write_1h = "5.000000";
  assert.equal(calculateCost(tokens, price).cache_write_nano, 25_000);
  delete price.pricing.tiers[0].image_cache_write;
  price.pricing.tiers[0].cache_write_1h = "10";
  assert.equal(calculateCost(tokens, price).cache_write_nano, 150_000);
});
