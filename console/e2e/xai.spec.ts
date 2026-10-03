import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import { xaiProviderSchema } from "../../src/config/schema";
import { accountViewSchema } from "../../src/providers/oauth/schema";
import type { ConfigurationView } from "./fixtures";

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
  const draft: ConfigurationView = {
    ...draftFixture(),
    config: {
      ...draftFixture().config,
      providers: [provider],
      api_keys: [{ id: "client", api_key: "masked", providers: ["xai"] }],
      model_prices: [],
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
  let releaseQuota!: () => void;
  let quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  await page.route("**/console/api/provider-accounts**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/quota")) await quotaReady;
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
    page.getByRole("status", { name: "Loading accounts" }),
  ).toBeVisible();
  await expect(page.getByText("Unknown plan", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage", exact: true }),
  ).toHaveCount(0);
  releaseQuota();
  await expect(
    page.getByRole("status", { name: "Loading accounts" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("xai@example.test", { exact: true }),
  ).toBeVisible();

  await expect(page.getByText(/Extra Usage: Enabled/)).toBeVisible();
  await expect(page.getByText(/Used \$1\.00 \/ \$10\.00/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status", { name: "Loading accounts" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("xai@example.test", { exact: true }),
  ).toBeVisible();
  releaseQuota();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
});

test("xAI account editor requests device authorization and supports cancellation", async ({
  page,
}) => {
  const saved = draftFixture();
  saved.config.providers = [];
  const initial: ConfigurationView = {
    ...saved,
    config: {
      ...saved.config,
      providers: [
        {
          type: "xai",
          id: "xai",
          name: "xAI",
          priority: 100,
          disabled: true,
          models: [],
          credentials: [],
          supports_websocket: false,
          supports_web_search: false,
          supports_context_management: false,
          anthropic_1m_context: false,
          emulate_claude_code: false,
          account_selection: "round_robin",
          allow_extra_usage: false,
          inject_x_search: false,
        },
      ],
    },
  };
  await mockApi(page, initial);
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

test("xAI distinguishes first failures, partial billing and retained data", async ({
  page,
}) => {
  const ref = crypto.randomUUID();
  const draft: ConfigurationView = draftFixture();
  draft.config.providers = [
    xaiProviderSchema.parse({
      type: "xai",
      id: "xai",
      disabled: false,
      priority: 100,
      models: ["grok-4.7"],
      credentials: [
        {
          id: "one",
          auth: { type: "oauth", account_ref: ref },
          priority: 100,
          disabled: false,
        },
      ],
    }),
  ];
  const account = accountViewSchema.parse({
    account_ref: ref,
    provider_id: "xai",
    status: "ready",
    email: "partial@example.test",
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
      last_error: "xAI account request failed (HTTP 503, upstream_error)",
    },
  });
  await mockApi(page, draft);
  await page.route("**/console/api/provider-accounts**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith("/health")
        ? { items: [] }
        : path.endsWith("/quota")
          ? account
          : { items: [account] },
    });
  });
  await page.goto("/console/providers/xai");
  await expect(page.getByRole("alert")).toContainText(
    "No quota data has been fetched yet.",
  );
  await expect(page.getByText(/Last successful data/)).toHaveCount(0);
  account.quota = {
    groups: [
      {
        id: "weekly",
        label: "Subscription credits",
        buckets: [
          {
            id: "weekly",
            label: "Subscription credits",
            window: "weekly",
            used_percent: null,
            remaining_fraction: null,
            reset_at: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      },
    ],
    subscription: null,
    updated_at: Date.now(),
    stale: false,
    last_error: null,
    xai_billing: {
      monthly_limit: 10000,
      included_used: 2500,
      billing_period_end: null,
      products: [],
    },
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Quota unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Monthly included usage: $25.00 / $100.00"),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("100% left", { exact: true })).toHaveCount(0);
  account.quota.xai_billing!.subscription_error =
    "xAI account request failed (HTTP 503, upstream_error)";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Subscription quota: xAI account request failed",
  );
  await expect(page.getByText(/Last successful data/)).toHaveCount(0);
  account.quota.xai_billing!.subscription_error = null;
  account.quota.last_error =
    "xAI account request failed (HTTP 503, upstream_error)";
  account.quota.stale = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Last successful data is retained.",
  );
  await expect(
    page.getByText("Monthly included usage: $25.00 / $100.00"),
  ).toBeVisible();
  account.quota.last_error = null;
  account.quota.stale = false;
  account.quota.extra_usage = {
    is_enabled: false,
    monthly_limit: 0,
    used_credits: 0,
    utilization: 100,
  };
  account.quota.xai_billing!.prepaid_balance = 0;
  for (const [id, name] of [
    ["free", "Free"],
    ["supergrok", "SuperGrok"],
  ]) {
    account.quota.subscription = { tier_id: id, tier_name: name, credits: [] };
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toBeVisible();
    await expect(page.getByText("Quota unknown", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText(
        "Remaining quota is not reported. Limits are enforced by xAI.",
      ),
    ).toBeVisible();
    await expect(page.getByText("100% left", { exact: true })).toHaveCount(0);
  }
  account.quota.xai_billing!.allow_access = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Access restricted", { exact: true }),
  ).toBeVisible();
});
