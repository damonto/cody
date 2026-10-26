import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { accountViewSchema } from "../src/providers/oauth/schema.ts";
import {
  accountQueryKey,
  accountsQueryKey,
  cacheAccounts,
  quotaQueryKey,
} from "../console/src/features/oauth-accounts/cache.ts";

function account(generation, status = "ready") {
  return accountViewSchema.parse({
    generation,
    account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    provider_id: "codex",
    status,
    email: "operator@example.test",
    project_id: null,
    codex: null,
    expires_at: null,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: {
      groups: [],
      subscription: null,
      updated_at: null,
      last_error: null,
      stale: true,
    },
  });
}
function fixture(t) {
  const cache = new QueryClient();
  t.after(() => cache.clear());
  const initial = account(1);
  const detail = accountQueryKey(initial.account_ref);
  const list = accountsQueryKey(initial.provider_id);
  const quotas = quotaQueryKey([initial.provider_id, initial.account_ref]);
  cache.setQueryData(detail, initial);
  cache.setQueryData(list, [initial]);
  cache.setQueryData(quotas, [initial]);
  return { cache, detail, list, quotas, initial };
}

test("account cache fences writes after asynchronous query cancellation", async (t) => {
  const { cache, detail, list, quotas, initial } = fixture(t);
  const gate = Promise.withResolvers();
  const cancel = cache.cancelQueries.bind(cache);
  t.mock.method(cache, "cancelQueries", async (...args) => {
    await gate.promise;
    return cancel(...args);
  });
  const stale = cacheAccounts(cache, [initial]);
  const replacement = account(2);
  cache.setQueryData(detail, replacement);
  cache.setQueryData(list, [replacement]);
  cache.setQueryData(quotas, [replacement]);
  gate.resolve();
  await stale;
  assert.equal(cache.getQueryData(detail).generation, 2);
  assert.equal(cache.getQueryData(list)[0].generation, 2);
  assert.equal(cache.getQueryData(quotas)[0].generation, 2);
});

test("cancelling an old fetch cannot restore its pre-authorization snapshot", async (t) => {
  const { cache, detail, list, quotas, initial } = fixture(t);
  const gate = Promise.withResolvers();
  const fetching = cache
    .fetchQuery({ queryKey: list, queryFn: () => gate.promise })
    .catch(() => undefined);
  const replacement = account(2);
  // The provider list can learn a newer generation before the individual query.
  cache.setQueryData(list, [replacement]);
  await cacheAccounts(cache, [initial]);
  assert.equal(cache.getQueryData(list)[0].generation, 2);
  assert.equal(cache.getQueryData(detail).generation, 2);
  assert.equal(cache.getQueryData(quotas)[0].generation, 2);
  gate.resolve([initial]);
  await fetching;
  assert.equal(cache.getQueryData(list)[0].generation, 2);
});

test("terminal refresh failures replace ready views and survive stale same-generation results", async (t) => {
  const { cache, detail, list, quotas, initial } = fixture(t);
  const rejected = account(1, "needs_reauthorization");
  await cacheAccounts(cache, [rejected]);
  await cacheAccounts(cache, [initial]);
  for (const key of [list, quotas])
    assert.equal(cache.getQueryData(key)[0].status, "needs_reauthorization");
  assert.equal(cache.getQueryData(detail).status, "needs_reauthorization");
  await cacheAccounts(cache, [account(2)]);
  assert.equal(cache.getQueryData(detail).status, "ready");
});

test("equal-generation refreshes update inventories without changing unloaded account lists", async (t) => {
  const cache = new QueryClient();
  t.after(() => cache.clear());
  const initial = account(1);
  await cacheAccounts(cache, [initial]);
  const update = { ...initial, models_error: "model discovery failed" };
  await cacheAccounts(cache, [update]);
  assert.equal(
    cache.getQueryData(accountQueryKey(initial.account_ref)).models_error,
    update.models_error,
  );
  assert.equal(
    cache.getQueryData(accountsQueryKey(initial.provider_id)),
    undefined,
  );
});

test("undated responses cannot replace a cached credential generation", async (t) => {
  const { cache, detail, initial } = fixture(t);
  const undated = { ...initial };
  delete undated.generation;
  await cacheAccounts(cache, [undated]);
  assert.equal(cache.getQueryData(detail).generation, initial.generation);
});
