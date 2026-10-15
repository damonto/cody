import assert from "node:assert/strict";
import test from "node:test";
import { storedSchema } from "../src/providers/oauth/state.ts";

function stored(provider_type) {
  return {
    account_ref: crypto.randomUUID(),
    provider_id: "provider",
    provider_type,
    generation: 2,
    status: "disconnected",
    connection: { provider_id: "provider", credential_id: "credential" },
    tokens: null,
    identity: null,
    project_id: null,
    codex: null,
    error: null,
    session: null,
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
  };
}

test("persisted OAuth states keep their provider, identity and default fields across parsing", () => {
  for (const provider of ["antigravity", "codex", "claude", "xai"]) {
    const input = stored(provider);
    const parsed = storedSchema.parse(input);
    assert.deepEqual(parsed, {
      ...input,
      authorization_generation: 0,
      claude_quota_revision: 0,
      ...(provider === "codex"
        ? {
            codex_quota_sync: {
              full_observed_at: 0,
              windows: [],
              plan_observed_at: 0,
              credits_observed_at: 0,
            },
          }
        : provider === "claude"
          ? { claude_quota_sync: { windows: [], extra_usage: null } }
          : {}),
    });
    assert.deepEqual(
      storedSchema.parse(JSON.parse(JSON.stringify(parsed))),
      parsed,
    );
  }
  const { provider_type, ...legacy } = stored("antigravity");
  assert.equal(storedSchema.parse(legacy).provider_type, provider_type);
});

test("persisted Claude state retains per-field quota observation revisions", () => {
  const input = {
    ...stored("claude"),
    claude_quota_revision: 3,
    claude_quota_sync: {
      windows: [{ group_id: "five_hour", revision: 2 }],
      extra_usage: { revision: 3, disabled_reason: "usage_limit_reached" },
    },
  };
  const parsed = storedSchema.parse(input);
  assert.deepEqual(parsed.claude_quota_sync, input.claude_quota_sync);
  assert.deepEqual(
    storedSchema.parse(JSON.parse(JSON.stringify(parsed))),
    parsed,
  );
});

test("persisted OAuth state rejects identity metadata from a different provider", () => {
  const identities = {
    codex: {
      account_id: "account",
      user_id: null,
      plan_type: null,
      subscription_active_until: null,
    },
    xai: { subject: "subject" },
    claude: {
      account_id: "account",
      organization_id: "org",
      organization_name: null,
      subscription_type: null,
      rate_limit_tier: null,
    },
    project_id: "google-project",
  };
  for (const provider of ["antigravity", "codex", "claude", "xai"]) {
    for (const [field, value] of Object.entries(identities)) {
      const matches =
        provider === field ||
        (provider === "antigravity" && field === "project_id");
      assert.equal(
        storedSchema.safeParse({ ...stored(provider), [field]: value }).success,
        matches,
      );
    }
  }
});
