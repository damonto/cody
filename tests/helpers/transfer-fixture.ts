import type { SqlDatabase } from "../../src/platform/bindings.ts";
import type { ObjectRef } from "../../src/transfer/protocol.ts";
import { storedSchema } from "../../src/providers/oauth/state.ts";
import { encryptConfig } from "../../src/control/crypto.ts";

/** No upstream or paid operations: all credentials and entitlements are fixtures. */
export async function seedTransferAccounts(
  db: SqlDatabase,
  key: string,
  put: (
    ref: ObjectRef | { kind: "health"; name: string },
    entries: [string, unknown][],
  ) => Promise<void>,
) {
  const records = [];
  const providers = (
    await db
      .prepare(
        "SELECT id, type FROM providers WHERE type <> 'ai_gateway' ORDER BY type",
      )
      .all<{ id: string; type: string }>()
  ).results;
  for (const provider of providers) {
    const ref = crypto.randomUUID(),
      credential = crypto.randomUUID();
    const now = Date.now(),
      connection = { provider_id: provider.id, credential_id: credential };
    const tokens = {
      access_token: "mock-access",
      refresh_token: "mock-refresh",
      expires_at: now - 1000,
    };
    const identity = { id: "mock-identity", email: "fixture@example.com" };
    const account = storedSchema.parse({
      account_ref: ref,
      provider_id: provider.id,
      provider_type: provider.type,
      generation: 7,
      status: "ready",
      connection,
      tokens,
      identity,
      error: null,
      project_id: provider.type === "antigravity" ? "mock-project" : null,
      ...(provider.type === "antigravity"
        ? {
            antigravity_initialization: {
              tokens,
              identity,
              connection,
              stage: "onboard",
              tier: "free",
              attempts: 2,
              next_at: now + 600000,
              deadline: now + 900000,
              error: null,
              last_result: "pending",
            },
          }
        : {}),
      codex:
        provider.type === "codex"
          ? {
              account_id: "mock-account",
              user_id: null,
              plan_type: "plus",
              subscription_active_until: null,
            }
          : null,
      ...(provider.type === "claude"
        ? {
            claude: {
              account_id: "mock-account",
              organization_id: "mock-org",
              organization_name: null,
              subscription_type: null,
              rate_limit_tier: null,
            },
          }
        : {}),
      ...(provider.type === "xai" ? { xai: { subject: "mock-subject" } } : {}),
      session: {
        id: crypto.randomUUID(),
        actor: "operator",
        status: "pending",
        state: "state",
        verifier: "verifier",
        challenge: "challenge",
        expires_at: now + 900000,
        connection,
        error: null,
        tokens: null,
        identity: null,
        next_at: now + 600000,
        flow: provider.type === "codex" ? "device" : "pkce",
        device_auth_id: provider.type === "codex" ? "mock-device" : null,
        user_code: provider.type === "codex" ? "mock-code" : null,
      },
      models: [],
      models_updated_at: null,
      models_error: null,
      quota: {
        groups: [],
        subscription: null,
        updated_at: now,
        last_error: null,
        stale: false,
        reset_credits: {
          available_count: 1,
          credits: [
            {
              id: "mock-credit",
              reset_type: "weekly",
              status: "available",
              granted_at: null,
              expires_at: null,
              title: null,
              description: null,
            },
          ],
          updated_at: now,
          error: null,
        },
      },
    });
    await db
      .prepare(
        "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(ref, provider.id, provider.type, now)
      .run();
    await db
      .prepare(
        "INSERT INTO provider_credentials (id, provider_id, name, auth_type, account_ref, priority, disabled, position, proxy_mode, version, created_at, updated_at, deleted_at) VALUES (?, ?, 'Historical OAuth', 'oauth', ?, 100, 1, 0, 'inherit', 1, ?, ?, ?)",
      )
      .bind(credential, provider.id, ref, now, now, now)
      .run();
    const ciphertext = await encryptConfig(account, key);
    const object: ObjectRef = { kind: "oauth", name: ref };
    await put(object, [["account", ciphertext]]);
    const operation = {
      credential_id: credential,
      account_ref: ref,
      credit_id: "mock-credit",
      redeem_request_id: crypto.randomUUID(),
      cooling_until: now + 3600000,
    };
    const health = {
      kind: "health" as const,
      name: `key:${provider.id}:${credential}`,
    };
    await put(health, [
      [
        "health",
        {
          failures: 2,
          failure_window_started_at: now,
          cooling_until: now + 3600000,
          reason: "quota",
        },
      ],
      [
        "lease:reset",
        { owner: "source-process", until: now + 60000, operation },
      ],
    ]);
    records.push({ object, health, account, ciphertext, operation });
  }
  return records;
}
