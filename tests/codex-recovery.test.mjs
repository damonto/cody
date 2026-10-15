import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWithConfiguredRetries,
  UpstreamAttemptTimeoutError,
} from "../src/gateway/http/upstream-retry.ts";
import {
  codexQuotaHeaders,
  codexQuotaEvent,
} from "../src/providers/codex/observations.ts";

const request = (signal) => () =>
  new Request("https://upstream.example/responses", {
    method: "POST",
    body: "unchanged",
    signal,
  });

test("authentication recovery records each send and keeps the retry budget", async () => {
  let sent = 0;
  let refreshes = 0;
  const headers = new Headers({
    authorization: "Bearer original",
    "x-request": "unchanged",
  });
  const authorizations = [];
  const result = await fetchWithConfiguredRetries(
    () => new Request(request()(), { headers }),
    { status_codes: [503], delays_ms: [0] },
    {
      send: async (request) => {
        authorizations.push(request.headers.get("authorization"));
        assert.equal(request.headers.get("x-request"), "unchanged");
        assert.equal(await request.text(), "unchanged");
        return new Response("body", { status: [401, 503, 200][sent++] });
      },
      recoverUnauthorized: async () => {
        refreshes++;
        const replacement = new Headers(headers);
        replacement.set("authorization", "Bearer recovered");
        return { headers: replacement };
      },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(refreshes, 1);
  assert.deepEqual(authorizations, [
    "Bearer original",
    "Bearer recovered",
    "Bearer recovered",
  ]);
  assert.equal(headers.get("authorization"), "Bearer original");
  assert.deepEqual(
    result.attempts.map(({ status }) => status),
    [401, 503, 200],
  );
  assert.deepEqual(
    result.attempts.map(({ attempt }) => attempt),
    [1, 2, 3],
  );
  assert.equal(result.attempts[0].retry_diagnostic.reason, "oauth_refresh");
  assert.equal(result.attempts[1].retry_diagnostic.reason, "status_match");
});

test("cancellation stops waiting for recovery and prevents replay", async () => {
  const started = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  const controller = new AbortController();
  let sent = 0;
  let cancelled = false;
  const operation = fetchWithConfiguredRetries(
    request(controller.signal),
    undefined,
    {
      send: async () => {
        sent++;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        );
      },
      recoverUnauthorized: async () => {
        started.resolve();
        return refresh.promise;
      },
    },
  );
  await started.promise;
  controller.abort();
  const result = await operation;
  assert.equal(result.error.name, "AbortError");
  assert.equal(sent, 1);
  assert.equal(cancelled, true);
  refresh.resolve({ headers: new Headers() });
});

test("authentication recovery cannot renew the original attempt deadline", async () => {
  const result = await fetchWithConfiguredRetries(request(), undefined, {
    attemptTimeoutMs: 20,
    send: async () => new Response("expired", { status: 401 }),
    recoverUnauthorized: () => new Promise(() => {}),
  });
  assert.ok(result.error instanceof UpstreamAttemptTimeoutError);
  assert.equal(result.attempts.length, 1);
});

test("Codex header observations parse windows, secondary-only families and credits", () => {
  const observation = codexQuotaHeaders(
    new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1800000000",
      "x-codex-spark-secondary-used-percent": "105",
      "x-codex-spark-secondary-window-minutes": "10080",
      "x-codex-spark-limit-name": "Spark",
      "x-codex-credits-has-credits": "TRUE",
      "x-codex-credits-unlimited": "0",
      "x-codex-credits-balance": "2.50",
      "x-codex-plan-type": "pro",
    }),
  );
  assert.equal(observation.groups.length, 2);
  assert.deepEqual(observation.groups[0].buckets[0], {
    id: "primary",
    label: "5-hour limit",
    window: "5h",
    window_seconds: 18000,
    used_percent: 12.5,
    remaining_fraction: 0.875,
    reset_at: new Date(1800000000000).toISOString(),
  });
  assert.equal(observation.groups[1].id, "codex_spark");
  assert.equal(observation.groups[1].buckets[0].remaining_fraction, 0);
  assert.equal(observation.groups[1].buckets[0].window, "weekly");
  assert.deepEqual(observation.credits_balance, {
    has_credits: true,
    unlimited: false,
    balance: "2.50",
  });
  assert.equal(observation.plan_type, "pro");
});

test("Codex events normalize documented and observed window forms without inventing missing fields", () => {
  for (const extra of [
    { "GPT-5.3-Codex-Spark": { primary: { used_percent: 75 } } },
    [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: { primary_window: { used_percent: 75 } },
      },
    ],
  ]) {
    const observation = codexQuotaEvent({
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300 },
        secondary: { used_percent: 20, window_minutes: 10080 },
      },
      additional_rate_limits: extra,
      credits: { has_credits: true, unlimited: false, balance: 1.5 },
    });
    assert.equal(observation.groups[0].buckets.length, 2);
    assert.equal(observation.groups[1].id, "gpt_5.3_codex_spark");
    assert.equal(observation.groups[1].buckets[0].remaining_fraction, 0.25);
    assert.equal(observation.groups[1].buckets[0].reset_at, null);
    assert.equal(observation.groups[0].limit_reached, undefined);
  }
  const camel = codexQuotaEvent({
    type: "codex.rate_limits",
    rateLimit: { primary: { usedPercent: 5, windowMinutes: 300 } },
    credits: { hasCredits: false, unlimited: true },
  });
  assert.equal(camel.groups[0].buckets[0].used_percent, 5);
  assert.equal(camel.credits_balance.unlimited, true);
});

test("malformed and oversized quota fields are ignored within bounded observations", () => {
  assert.equal(
    codexQuotaHeaders(
      new Headers({ "x-codex-code-review-primary-used-percent": "10" }),
    ).groups[0].id,
    "code_review",
  );
  assert.equal(codexQuotaHeaders(new Headers()), undefined);
  assert.equal(
    codexQuotaEvent({
      type: "response.completed",
      rate_limits: { primary: { used_percent: 20 } },
    }),
    undefined,
  );
  for (const invalid of ["NaN", "Infinity", "", -1, 1e50]) {
    assert.equal(
      codexQuotaHeaders(
        new Headers({ "x-codex-primary-used-percent": String(invalid) }),
      ),
      undefined,
    );
  }
  const observation = codexQuotaEvent({
    type: "codex.rate_limits",
    rate_limits: { primary: { used_percent: 0, reset_at: 1e50 } },
    additional_rate_limits: Array.from({ length: 100 }, (_, i) => ({
      limit_name: `limit-${i}`,
      primary: { used_percent: i },
    })),
    credits: { has_credits: true, unlimited: false, balance: "x".repeat(129) },
  });
  assert.equal(observation.groups.length, 32);
  assert.equal(observation.groups[0].buckets[0].reset_at, null);
  assert.equal(observation.credits_balance, undefined);
});
