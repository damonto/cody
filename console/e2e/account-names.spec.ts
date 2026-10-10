import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import {
  newAntigravityProvider,
  newCodexProvider,
  newClaudeProvider,
  newXaiProvider,
} from "../../tests/helpers/native-provider-fixtures";
import { accountViewSchema } from "../../src/providers/oauth/schema";

for (const create of [
  newAntigravityProvider,
  newCodexProvider,
  newClaudeProvider,
  newXaiProvider,
]) {
  for (const email of ["person@example.test", null]) {
    test(`${create().type}: authorization ${email ? "email" : "identity"} names a new account and preserves edits`, async ({
      page,
    }) => {
      const provider = create();
      const ref = crypto.randomUUID();
      const account = accountViewSchema.parse({
        account_ref: ref,
        provider_id: provider.id,
        status: "ready",
        email,
        project_id: null,
        expires_at: null,
        error: null,
        models: [],
        models_updated_at: null,
        models_error: null,
        codex:
          provider.type === "codex"
            ? {
                account_id: "chatgpt-id",
                user_id: null,
                plan_type: null,
                subscription_active_until: null,
              }
            : null,
        claude:
          provider.type === "claude"
            ? {
                account_id: "claude-id",
                organization_id: "org",
                organization_name: null,
                subscription_type: null,
                rate_limit_tier: null,
              }
            : null,
        xai: provider.type === "xai" ? { subject: "xai-id" } : null,
        quota: {
          groups: [],
          subscription: null,
          updated_at: null,
          stale: false,
          last_error: null,
        },
      });
      const fixture = draftFixture();
      const api = await mockApi(page, {
        ...fixture,
        config: {
          ...fixture.config,
          providers: [provider],
          api_keys: [],
          model_prices: [],
        },
      });
      await page.route("**/console/api/oauth/sessions**", (route) =>
        route.fulfill({
          json: {
            id: `${ref}.${crypto.randomUUID()}`,
            account_ref: ref,
            status: "complete",
            expires_at: Date.now() + 60_000,
            url: null,
            flow:
              provider.type === "codex" || provider.type === "xai"
                ? "device"
                : "pkce",
            user_code: null,
            verification_uri: null,
            error: null,
            can_retry: false,
            account,
          },
        }),
      );
      await page.route("**/console/api/provider-accounts**", (route) =>
        route.fulfill({
          json: route.request().url().includes("/health")
            ? { items: [] }
            : route.request().url().includes(ref)
              ? account
              : { items: [account] },
        }),
      );
      // The already-authorized path must carry the same identity as OAuth completion.
      await page.goto(`/console/providers/${provider.type}`);
      await page.getByRole("button", { name: /^Add .* account$/ }).click();
      const dialog = page.getByRole("dialog");
      if (email) {
        await dialog.getByRole("button", { name: /^Authorize with/ }).click();
        await expect(
          dialog.getByText("Authorization: complete", { exact: true }),
        ).toBeVisible();
      } else {
        await dialog
          .getByLabel("Use an existing account for this provider")
          .click();
        await page
          .getByRole("option", { name: `${email ?? ref} · ready`, exact: true })
          .click();
      }
      api.loseNextSaveResponse();
      await dialog
        .getByRole("button", { name: "Save account", exact: true })
        .click();
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("button", { name: "Save account", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      const saved = api
        .current()
        .config.providers.find((item) => item.id === provider.id)!;
      const expected =
        email ??
        (provider.type === "antigravity"
          ? `antigravity:${ref}`
          : provider.type === "codex"
            ? "chatgpt-id"
            : provider.type === "claude"
              ? "claude-id"
              : "xai-id");
      expect(saved.credentials[0]?.name).toBe(expected);
      // Old/user-chosen names survive refresh, editing, and reauthorization.
      saved.credentials[0]!.name = "Custom account name";
      await page.reload();
      await page.getByRole("button", { name: "Manage", exact: true }).click();
      account.email = "reauthorized@example.test";
      await dialog.getByRole("button", { name: /Reauthorize/ }).click();
      await expect(
        dialog.getByText("Authorization: complete", { exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Save account", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      expect(
        api.current().config.providers.find((item) => item.id === provider.id)
          ?.credentials[0]?.name,
      ).toBe("Custom account name");
    });
  }
}
