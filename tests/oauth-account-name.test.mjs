import assert from "node:assert/strict";
import test from "node:test";
import { accountName } from "../console/src/features/oauth-accounts/account-name.ts";

test("new OAuth credential names prefer email then the provider's stable identity", () => {
  const view = {
    account_ref: crypto.randomUUID(),
    email: "person@example.test",
    codex: { account_id: "chatgpt-account" },
    claude: { account_id: "claude-account" },
    xai: { subject: "xai-subject" },
  };
  for (const [provider, identifier] of [
    ["antigravity", `antigravity:${view.account_ref}`],
    ["codex", "chatgpt-account"],
    ["claude", "claude-account"],
    ["xai", "xai-subject"],
  ]) {
    assert.equal(accountName(provider, view), view.email);
    assert.equal(accountName(provider, { ...view, email: null }), identifier);
    assert.equal(
      accountName(provider, { account_ref: view.account_ref, email: " " }),
      `${provider}:${view.account_ref}`,
    );
  }
});
