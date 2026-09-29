import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import { xaiProviderSchema } from "../../src/config/schema";
import { accountViewSchema } from "../../src/providers/oauth/schema";
import type { Draft } from "../src/lib/api";

test("xAI settings default to disabled, no extra usage and no resets", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/console/api/provider-accounts?*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/console/providers/xai");
  await expect(
    page.getByRole("heading", { name: "xAI", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("xAI settings", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Allow Extra Usage", { exact: true }),
  ).toBeVisible();
  const search = page.getByRole("switch", {
    name: "Enable native X Search",
    exact: true,
  });
  await expect(search).not.toBeChecked();
  await search.click();
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Enable native X Search", exact: true }),
  ).toBeChecked();
});

test("xAI cards show native quota and paid usage without reset controls", async ({
  page,
}) => {
  const ref = crypto.randomUUID();
  const provider = xaiProviderSchema.parse({
    type: "xai",
    id: "xai",
    priority: 100,
    disabled: false,
    models: ["grok-4.7"],
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
      api_keys: [{ id: "client", api_key: "masked", providers: ["xai"] }],
      model_policies: [],
    },
  };
  const account = accountViewSchema.parse({
    account_ref: ref,
    provider_id: "xai",
    status: "ready",
    email: "xai@example.test",
    project_id: null,
    xai: { subject: "account" },
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
  await page.goto("/console/providers/xai");
  await expect(
    page.getByText("xai@example.test", { exact: true }),
  ).toBeVisible();

  await expect(page.getByText(/Extra Usage: Enabled/)).toBeVisible();
  await expect(page.getByText(/Used \$1\.00 \/ \$10\.00/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("xai@example.test", { exact: true }),
  ).toBeVisible();
});

test("xAI account editor requests device authorization and supports cancellation", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/console/api/provider-accounts**", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  const ref = crypto.randomUUID();
  const account = accountViewSchema.parse({
    account_ref: ref,
    provider_id: "xai",
    status: "authorizing",
    email: null,
    project_id: null,
    expires_at: null,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: {
      groups: [],
      subscription: null,
      updated_at: null,
      stale: true,
      last_error: null,
    },
  });
  const session = {
    id: `${ref}.${crypto.randomUUID()}`,
    account_ref: ref,
    status: "pending",
    expires_at: Date.now() + 600000,
    url: "https://auth.x.ai/activate",
    flow: "device",
    user_code: "TEST-CODE",
    verification_uri: "https://auth.x.ai/activate",
    error: null,
    can_retry: false,
    account,
  };
  await page.route("**/console/api/oauth/sessions**", async (route) => {
    if (route.request().method() === "POST")
      expect(route.request().postDataJSON()).toMatchObject({
        provider_id: "xai",
        flow: "device",
      });
    if (route.request().method() === "DELETE") session.status = "cancelled";
    await route.fulfill({ json: session });
  });
  await page.goto("/console/providers/xai");
  await page.getByRole("button", { name: "Add xAI account" }).click();
  await page.getByRole("button", { name: "Authorize with xAI" }).click();
  await expect(page.getByLabel("Device code", { exact: true })).toHaveText(
    "TEST-CODE",
  );
  await expect(
    page.getByRole("link", { name: "Open xAI authorization" }),
  ).toHaveAttribute("href", "https://auth.x.ai/activate");
  await page.getByRole("button", { name: "Cancel authorization" }).click();
  await expect(page.getByText("Authorization: cancelled")).toBeVisible();
});
