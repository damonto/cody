import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import { claudeProviderSchema } from "../../src/config/schema";
import { accountViewSchema } from "../../src/providers/oauth/schema";
import type { Draft } from "../src/lib/api";

test("Claude settings default to disabled, no extra usage and no resets", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/console/api/provider-accounts?*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/console/providers/claude");
  await expect(
    page.getByRole("heading", { name: "Claude", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByText("Claude settings", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Allow Extra Usage", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Use resets automatically", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Responses WebSocket", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Claude cards show native quota and organization without reset controls", async ({
  page,
}) => {
  const ref = crypto.randomUUID();
  const provider = claudeProviderSchema.parse({
    type: "claude",
    id: "claude",
    priority: 100,
    disabled: false,
    models: ["claude-sonnet-4-6"],
    credentials: [
      {
        id: "one",
        auth: { type: "oauth", account_ref: ref },
        priority: 100,
        disabled: false,
      },
    ],
  });
  const draft: Draft = {
    ...draftFixture(),
    config: {
      ...draftFixture().config,
      providers: [provider],
      api_keys: [{ id: "client", api_key: "masked", providers: ["claude"] }],
      model_policies: [],
    },
  };
  const account = accountViewSchema.parse({
    account_ref: ref,
    provider_id: "claude",
    status: "ready",
    email: "claude@example.test",
    project_id: null,
    claude: {
      account_id: "account",
      organization_id: "org",
      organization_name: "Personal organization",
      subscription_type: "claude_max",
      rate_limit_tier: "max_5x",
    },
    expires_at: Date.now() + 3600000,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: {
      groups: [
        {
          id: "five_hour",
          label: "Five hour",
          buckets: [
            {
              id: "five_hour",
              label: "Five hour",
              window: "5h",
              remaining_fraction: 0.7,
              used_percent: 30,
              reset_at: new Date(Date.now() + 3600000).toISOString(),
            },
          ],
        },
      ],
      subscription: null,
      updated_at: Date.now(),
      stale: false,
      last_error: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 100,
        utilization: 10,
      },
    },
  });
  await mockApi(page, draft);
  await page.route("**/console/api/provider-accounts**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: path.endsWith("/health")
        ? { items: [] }
        : path.endsWith("/quota")
          ? account
          : { items: [account] },
    });
  });
  await page.goto("/console/providers/claude");
  await expect(
    page.getByText("claude@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Personal organization", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Extra Usage: Enabled/)).toBeVisible();
  await expect(page.getByText(/Used \$1\.00 \/ \$10\.00/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("claude@example.test", { exact: true }),
  ).toBeVisible();
});
