import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEditorSchema,
  antigravityProvider,
  applyAccount,
  applySettings,
  moveAccount,
  newAccount,
  newAntigravityProvider,
  settingsEditorSchema,
  settingsFormValues,
} from "../console/src/features/antigravity/form-options.ts";
import { antigravityProviderSchema } from "../src/config/schema.ts";

function account() {
  return {
    ...newAccount(),
    auth: { type: "oauth", account_ref: crypto.randomUUID() },
  };
}

test("the fixed provider starts disabled and needs no fabricated accounts or models", () => {
  const provider = newAntigravityProvider();
  assert.equal(provider.id, "antigravity");
  assert.equal(provider.disabled, true);
  assert.deepEqual(provider.credentials, []);
  assert.deepEqual(provider.models, []);
  assert.deepEqual(antigravityProviderSchema.parse(provider), provider);
  assert.deepEqual(antigravityProvider({ providers: [] }), provider);
  assert.equal(antigravityProvider({ providers: [provider] }), provider);
});

test("pending accounts keep separate stable identities without inventing OAuth references", () => {
  const first = newAccount();
  const second = newAccount();
  assert.notEqual(first.rowId, second.rowId);
  assert.notEqual(first.id, second.id);
  assert.equal(first.auth.account_ref, "");
  assert.equal(second.auth.account_ref, "");
});

test("missing or invalid OAuth references require authorization instead of exposing UUID errors", () => {
  for (const ref of ["", "invalid", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]) {
    const value = newAccount();
    value.auth.account_ref = ref;
    const parsed = accountEditorSchema.safeParse(value);
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error.issues.map(({ path, message }) => ({ path, message })),
      [
        {
          path: ["auth", "account_ref"],
          message: "Authorize or select a Google account before saving.",
        },
      ],
    );
  }
});

test("saving an account preserves provider settings and strips form-only metadata", () => {
  const provider = {
    ...newAntigravityProvider(),
    priority: 250,
    models: ["gemini-real"],
    proxy_group: "google-egress",
    model_routes: { alias: { model: "gemini-real" } },
    retry: { status_codes: [503], delays_ms: [1000] },
  };
  const first = account();
  const saved = applyAccount(provider, first);
  const { rowId: _rowId, ...expected } = first;
  assert.deepEqual(saved, { ...provider, credentials: [expected] });
  assert.deepEqual(provider.credentials, []);
  const updated = applyAccount(saved, { ...first, priority: 50 });
  assert.equal(updated.credentials.length, 1);
  assert.deepEqual(updated.credentials[0], { ...expected, priority: 50 });
  assert.deepEqual(antigravityProviderSchema.parse(updated), updated);
});

test("account editing preserves duplicate-account configuration rules", () => {
  const first = account();
  const provider = applyAccount(newAntigravityProvider(), first);
  assert.throws(
    () => applyAccount(provider, { ...newAccount(), auth: { ...first.auth } }),
    /an account may only be attached once/,
  );
});

test("settings can be saved independently before the first authorization", () => {
  const provider = newAntigravityProvider();
  const saved = applySettings(provider, {
    ...settingsFormValues(provider),
    priority: 200,
    proxy_group: "google-egress",
  });
  assert.deepEqual(saved.credentials, []);
  assert.deepEqual(saved.models, []);
  assert.equal(saved.disabled, true);
  assert.equal(saved.priority, 200);
  assert.equal(saved.proxy_group, "google-egress");
  assert.doesNotThrow(() => antigravityProviderSchema.parse(saved));
});

test("settings preserve credentials and serialize routes without editable row identities", () => {
  const provider = applyAccount(newAntigravityProvider(), account());
  const saved = applySettings(provider, {
    ...settingsFormValues(provider),
    disabled: false,
    models: ["gemini-real"],
    routes: [
      { rowId: crypto.randomUUID(), alias: " alias ", model: "gemini-real" },
    ],
    retry: { status_codes: [429, 503], delays_ms: [1000, 2000] },
  });
  assert.deepEqual(saved.credentials, provider.credentials);
  assert.deepEqual(saved.model_routes, { alias: { model: "gemini-real" } });
  assert.equal("routes" in saved, false);
  assert.doesNotMatch(JSON.stringify(saved), /rowId/);
  assert.deepEqual(antigravityProviderSchema.parse(saved), saved);
});

test("duplicate normalized aliases are rejected before settings are saved", () => {
  const value = settingsFormValues(newAntigravityProvider());
  value.routes = ["alias", " alias "].map((alias) => ({
    rowId: crypto.randomUUID(),
    alias,
    model: "gemini-real",
  }));
  const parsed = settingsEditorSchema.safeParse(value);
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.error.issues[0].path, ["routes", 1, "alias"]);
  assert.equal(parsed.error.issues[0].message, "Model aliases must be unique");
});

test("reordering accounts retains immutable IDs and references without mutating snapshots", () => {
  const first = account();
  const second = account();
  const provider = applyAccount(
    applyAccount(newAntigravityProvider(), first),
    second,
  );
  const moved = moveAccount(provider, second.id, -1);
  assert.deepEqual(moved.credentials, [...provider.credentials].reverse());
  assert.equal(provider.credentials[0].id, first.id);
  assert.equal(
    provider.credentials[1].auth.account_ref,
    second.auth.account_ref,
  );
  assert.equal(moveAccount(provider, first.id, -1), provider);
  assert.equal(moveAccount(provider, second.id, 1), provider);
  assert.equal(moveAccount(provider, "missing", 1), provider);
});
