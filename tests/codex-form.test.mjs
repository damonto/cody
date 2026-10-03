import { newCodexProvider } from "./helpers/native-provider-fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEditorSchema,
  applyAccount,
  applySettings,
  moveAccount,
  newAccount,
  setAccountDisabled,
  settingsFormValues,
} from "../console/src/features/codex/form-options.ts";
import { usableCredits } from "../console/src/features/codex/status.ts";
import { relative } from "../console/src/features/codex/plan.ts";
import { codexProviderSchema } from "../src/config/schema.ts";

function account() {
  return {
    ...newAccount(),
    auth: { type: "oauth", account_ref: crypto.randomUUID() },
  };
}

test("the fixed Codex provider starts disabled with round robin and no resets spent", () => {
  const provider = newCodexProvider();
  assert.match(provider.id, /^[0-9a-f-]{36}$/);
  assert.equal(provider.disabled, true);
  assert.equal(provider.account_selection, "round_robin");
  assert.equal(provider.auto_consume_resets, false);
  assert.deepEqual(provider.credentials, []);
  assert.deepEqual(codexProviderSchema.parse(provider), provider);
});

test("an account needs a ChatGPT authorization before it can be saved", () => {
  const parsed = accountEditorSchema.safeParse(newAccount());
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error.issues.map(({ path, message }) => ({ path, message })),
    [
      {
        path: ["auth", "account_ref"],
        message: "Authorize or select an account before saving.",
      },
    ],
  );
});

test("saving an account strips form metadata and rejects attaching it twice", () => {
  const first = account();
  const provider = applyAccount(newCodexProvider(), first);
  const { rowId: _rowId, ...expected } = first;
  assert.deepEqual(provider.credentials, [expected]);
  assert.doesNotMatch(JSON.stringify(provider), /rowId/);
  assert.throws(() =>
    applyAccount(provider, { ...newAccount(), auth: { ...first.auth } }),
  );
});

test("balancing settings save without touching accounts", () => {
  const provider = applyAccount(newCodexProvider(), account());
  const saved = applySettings(provider, {
    ...settingsFormValues(provider),
    disabled: false,
    models: ["gpt-5.5-codex"],
    account_selection: "session_affinity",
    auto_consume_resets: true,
    routes: [
      { rowId: crypto.randomUUID(), alias: "codex", model: "gpt-5.5-codex" },
    ],
  });
  assert.deepEqual(saved.credentials, provider.credentials);
  assert.equal(saved.account_selection, "session_affinity");
  assert.equal(saved.auto_consume_resets, true);
  assert.deepEqual(saved.model_routes, { codex: { model: "gpt-5.5-codex" } });
  assert.deepEqual(codexProviderSchema.parse(saved), saved);
  assert.deepEqual(
    settingsFormValues(saved).routes.map(({ alias, model }) => [alias, model]),
    [["codex", "gpt-5.5-codex"]],
  );
});

test("toggling and reordering accounts leave the original draft untouched", () => {
  const [first, second] = [account(), account()];
  const provider = applyAccount(
    applyAccount(newCodexProvider(), first),
    second,
  );
  const disabled = setAccountDisabled(provider, first.id, true);
  assert.deepEqual(
    disabled.credentials.map((credential) => credential.disabled),
    [true, false],
  );
  assert.equal(provider.credentials[0].disabled, false);
  const moved = moveAccount(provider, second.id, -1);
  assert.deepEqual(moved.credentials, [...provider.credentials].reverse());
  assert.equal(moveAccount(provider, first.id, -1), provider);
  assert.equal(moveAccount(provider, "missing", 1), provider);
});

test("relative times show the largest unit and the next one only when it is not zero", () => {
  const now = Date.UTC(2026, 8, 28);
  const minute = 60_000;
  for (const [offset, text] of [
    [20_000, "in <1m"],
    [45 * minute, "in 45m"],
    [59.6 * minute, "in 1h"],
    [125 * minute, "in 2h 5m"],
    [120 * minute, "in 2h"],
    [(26 * 60 + 30) * minute, "in 1d 2h"],
    [-3 * 1440 * minute, "3d ago"],
    [-(3 * 1440 + 5) * minute, "3d ago"],
  ])
    assert.equal(relative(now + offset, now), text, String(offset));
});

test("reset selection excludes unknown status and spent or expired credits", () => {
  const now = Date.now();
  const credits = [null, "redeeming", "redeemed", "available"].map(
    (status, index) => ({
      id: String(index),
      status,
      expires_at: new Date(now + 60000).toISOString(),
    }),
  );
  assert.deepEqual(
    usableCredits(credits, now).map((credit) => credit.id),
    ["3"],
  );
  assert.deepEqual(usableCredits(credits, now + 60001), []);
});
