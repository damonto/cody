import { isConfigurationMutation } from "./fixtures";
import {
  expect,
  test,
  type Page,
  type Locator,
  type Route,
  type Request as BrowserRequest,
} from "@playwright/test";
import type { ConfigurationView } from "./fixtures";
import { antigravityProviderSchema } from "../../src/config/schema";
import {
  accountViewSchema,
  modelSchema,
  type AccountView,
  type SessionView,
} from "../../src/providers/oauth/schema";
import { draftFixture, mockApi } from "./fixtures";

const model = modelSchema.parse({
  id: "gemini-real",
  display_name: "Gemini real",
  input_token_limit: 1000000,
  output_token_limit: 64000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function account(
  ref: string = crypto.randomUUID(),
  provider = "antigravity",
  ready = true,
): AccountView {
  return accountViewSchema.parse({
    account_ref: ref,
    provider_id: provider,
    status: ready ? "ready" : "authorizing",
    email: ready ? `user-${ref.slice(0, 4)}@example.test` : null,
    project_id: ready ? "project" : null,
    expires_at: ready ? Date.now() + 3600000 : null,
    error: null,
    models: ready ? [model] : [],
    models_updated_at: ready ? Date.now() : null,
    models_error: null,
    quota: {
      groups: [],
      subscription: null,
      updated_at: null,
      stale: true,
      last_error: null,
    },
  });
}
function configured(accounts: AccountView[]): ConfigurationView {
  const draft: ConfigurationView = draftFixture();
  draft.config.providers.push(
    antigravityProviderSchema.parse({
      id: "antigravity",
      type: "antigravity",
      priority: 100,
      disabled: accounts.length === 0,
      models: accounts.length ? [model.id] : [],
      credentials: accounts.map((account, index) => ({
        id: `account-${index + 1}`,
        auth: { type: "oauth", account_ref: account.account_ref },
        priority: 100 - index,
        disabled: false,
      })),
    }),
  );
  return draft;
}
async function mockOAuth(page: Page, initial: AccountView[] = []) {
  const accounts = new Map(
    initial.map((value) => [value.account_ref, structuredClone(value)]),
  );
  const sessions = new Map<string, SessionView>();
  const controls = {
    delayProject: false,
    projectRetries: 0,
    modelCalls: 0,
    accountListCalls: 0,
    failCallback: false,
    failQuota: false,
    quotaCalls: 0,
    callbackCalls: 0,
    disconnects: new Array<string>(),
    starts: new Array<Record<string, unknown>>(),
  };
  await page.route(
    (url) => url.pathname.startsWith("/console/api/oauth/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/sessions")) {
        const input: Record<string, unknown> = request.postDataJSON();
        controls.starts.push(input);
        const ref =
          typeof input.account_ref === "string"
            ? input.account_ref
            : crypto.randomUUID();
        const view =
          accounts.get(ref) ?? account(ref, String(input.provider_id), false);
        accounts.set(ref, view);
        const id = `${ref}.${crypto.randomUUID()}`;
        const session: SessionView = {
          id,
          account_ref: ref,
          status: "pending",
          expires_at: Date.now() + 600000,
          url: "https://accounts.google.com/o/oauth2/v2/auth?state=e2e-state",
          flow: "pkce",
          user_code: null,
          verification_uri: null,
          error: null,
          can_retry: false,
          account: view,
        };
        sessions.set(id, session);
        await route.fulfill({ json: session });
        return;
      }
      const id = decodeURIComponent(path.split("/")[5]);
      const session = sessions.get(id);
      if (!session) {
        await route.fulfill({
          status: 404,
          json: { error: "Missing test session" },
        });
        return;
      }
      if (path.endsWith("/callback")) {
        controls.callbackCalls++;
        if (controls.failCallback) {
          controls.failCallback = false;
          await route.fulfill({
            status: 400,
            json: { error: "Invalid callback URL or OAuth state" },
          });
          return;
        }
        const ready = account(session.account_ref, session.account.provider_id);
        if (controls.delayProject) {
          ready.status = "initializing";
          ready.project_id = null;
          ready.models = [];
          ready.models_updated_at = null;
          ready.project_initialization = {
            status: "pending",
            next_retry_at: Date.now() + 5000,
            error: null,
          };
        }
        accounts.set(ready.account_ref, ready);
        session.account = ready;
        session.status = "complete";
        session.url = null;
      }
      if (request.method() === "DELETE") {
        session.status = "cancelled";
        session.url = null;
      }
      await route.fulfill({ json: session });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/console/api/provider-accounts"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/console/api/provider-accounts/health") {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      if (url.pathname === "/console/api/provider-accounts") {
        controls.accountListCalls++;
        await route.fulfill({
          json: {
            items: [...accounts.values()].filter(
              (account) =>
                account.provider_id === url.searchParams.get("provider_id"),
            ),
          },
        });
        return;
      }
      const ref = url.pathname.split("/")[4];
      const value = accounts.get(ref);
      if (!value) {
        await route.fulfill({
          status: 404,
          json: { error: "Unknown test account" },
        });
        return;
      }
      if (url.pathname.endsWith("/quota")) {
        controls.quotaCalls++;
        if (controls.failQuota) {
          await route.fulfill({
            status: 503,
            json: { error: "Quota refresh temporarily unavailable" },
          });
          return;
        }
        value.quota = {
          groups: [
            {
              id: "gemini",
              label: "Gemini weekly",
              buckets: [
                {
                  id: "week",
                  label: "Weekly",
                  window: "weekly",
                  remaining_fraction: 0.75,
                  reset_at: "2026-10-01T00:00:00Z",
                },
              ],
            },
          ],
          subscription: { tier_id: "pro", tier_name: "Pro", credits: [] },
          updated_at: Date.now(),
          stale: false,
          last_error: null,
        };
      }
      if (url.pathname.endsWith("/disconnect")) {
        controls.disconnects.push(ref);
        value.status = "disconnected";
      }
      if (url.pathname.endsWith("/models")) {
        controls.modelCalls++;
        value.models = [model];
        value.models_updated_at = Date.now();
      }
      if (url.pathname.endsWith("/retry-project")) {
        controls.projectRetries++;
        value.project_initialization = {
          status: "pending",
          next_retry_at: Date.now() + 5000,
          error: null,
        };
      }
      await route.fulfill({ json: value });
    },
  );
  return { controls, accounts, sessions };
}
async function authorize(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Authorize with Google", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Open Google authorization" }),
  ).toBeVisible();
  await dialog
    .getByLabel("Localhost callback URL")
    .fill(
      "http://localhost:51121/oauth-callback?code=test-code&state=e2e-state",
    );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Authorization: complete", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save account", exact: true }),
  ).toBeEnabled();
}

test("Antigravity saves account selection and displays per-model cooldowns", async ({
  page,
}) => {
  const ready = account();
  await mockApi(page, configured([ready]));
  await mockOAuth(page, [ready]);
  await page.route("**/console/api/provider-accounts/health?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            credential_id: "account-1",
            account_ref: ready.account_ref,
            available: true,
            cooling_until: null,
            cooldown_reason: null,
            model_cooldowns: [
              {
                model: "gemini-real",
                reason: "quota",
                until: Date.now() + 60_000,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/console/providers/antigravity");
  await expect(page.getByText("gemini-real", { exact: true })).toBeVisible();
  await expect(page.getByText(/Quota \/ rate limit until/)).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Account selection" }),
  ).toHaveText("Round robin");
  await dialog.getByRole("combobox", { name: "Account selection" }).click();
  await page
    .getByRole("option", { name: "Session affinity (fill first)" })
    .click();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Account selection" }),
  ).toHaveText("Session affinity (fill first)");
});

test("Providers lists only implemented providers and Antigravity is a fixed account page", async ({
  page,
}) => {
  await mockApi(page);
  await mockOAuth(page);
  await page.goto("/console/providers");
  await expect(page).toHaveURL(/\/console\/providers\/ai-gateway$/);
  await expect(
    page.getByRole("button", { name: "Add provider", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "AI Gateway", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Antigravity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Codex", exact: true }),
  ).toBeVisible();
  for (const name of ["Claude", "xAI"])
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Grok", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Antigravity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Antigravity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Google account", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add provider", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("example-provider", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Configured providers", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Provider name", { exact: true })).toHaveCount(
    0,
  );
  for (const name of ["General", "Models", "Routing & retry"])
    await expect(dialog.getByRole("tab", { name, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Antigravity", exact: true }),
  ).toBeHidden();
});

test("the provider status sits next to the title on desktop and mobile", async ({
  page,
}) => {
  await mockApi(page);
  await mockOAuth(page);
  await page.goto("/console/providers/antigravity");
  const heading = page.getByRole("heading", {
    name: "Antigravity",
    exact: true,
  });
  const badge = heading.locator("..").getByText("disabled", { exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(heading).toBeVisible();
    await expect(badge).toBeVisible();
    const titleBox = await heading.boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(badgeBox).not.toBeNull();
    expect(badgeBox!.x - (titleBox!.x + titleBox!.width)).toBeGreaterThan(0);
    expect(badgeBox!.x - (titleBox!.x + titleBox!.width)).toBeLessThanOrEqual(
      16,
    );
    expect(
      Math.abs(
        badgeBox!.y +
          badgeBox!.height / 2 -
          (titleBox!.y + titleBox!.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
  }
});

test("Antigravity authorizes without entering provider IDs, credential IDs or OAuth client settings", async ({
  page,
}) => {
  const clientRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/oauth/clients/"))
      clientRequests.push(request.url());
  });
  await mockApi(page, configured([]));
  const mock = await mockOAuth(page);
  await page.goto("/console/providers/antigravity");
  await expect(page.getByText(/OAuth client|Client ID:/)).toHaveCount(0);
  await expect(page.getByLabel(/client secret/i)).toHaveCount(0);
  await expect(
    page.getByText(/CONFIG_ENCRYPTION_KEY|No additional Worker Secret/),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Provider name", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel("Credential ID", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Save account", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText("Invalid UUID", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "Authorize with Google", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Open Google authorization" }),
  ).toBeVisible();
  expect(mock.controls.starts).toHaveLength(1);
  expect(mock.controls.starts[0]).toMatchObject({
    provider_id: "antigravity",
    credential_id: expect.any(String),
    version: 1,
  });
  expect(clientRequests).toEqual([]);
});

test("accounts can be saved while project setup continues and become ready through polling", async ({
  page,
}) => {
  await mockApi(page, configured([]));
  const mock = await mockOAuth(page);
  mock.controls.delayProject = true;
  await page.goto("/console/providers/antigravity");
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await authorize(dialog);
  await expect(
    dialog.getByText(/Project setup continues in the background/),
  ).toBeVisible();
  expect(mock.controls.modelCalls).toBe(0);
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(
    page.getByText(/Project setup continues in the background/),
  ).toBeVisible();
  const pending = [...mock.accounts.values()][0];
  Object.assign(pending, account(pending.account_ref, pending.provider_id), {
    project_initialization: null,
  });
  await expect(
    page.getByText(/Project setup continues in the background/),
  ).not.toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  expect(mock.controls.callbackCalls).toBe(1);
});

test("project setup can be retried from a saved account without another Google authorization", async ({
  page,
}) => {
  const pending = account();
  pending.status = "initializing";
  pending.project_id = null;
  pending.project_initialization = {
    status: "error",
    next_retry_at: null,
    error:
      "Project setup is still unavailable after ten minutes; retry project initialization",
  };
  await mockApi(page, configured([pending]));
  const mock = await mockOAuth(page, [pending]);
  await page.goto("/console/providers/antigravity");
  await page
    .getByRole("button", { name: "Retry project initialization", exact: true })
    .click();
  await expect(
    page.getByText(/Project setup continues in the background/),
  ).toBeVisible();
  expect(mock.controls.projectRetries).toBe(1);
  expect(mock.controls.starts).toHaveLength(0);
});

test("project status polling does not repeatedly refresh ready account quotas", async ({
  page,
}) => {
  const ready = account();
  const pending = account();
  pending.status = "initializing";
  pending.project_id = null;
  pending.project_initialization = {
    status: "pending",
    next_retry_at: Date.now() + 5000,
    error: null,
  };
  await mockApi(page, configured([ready, pending]));
  const mock = await mockOAuth(page, [ready, pending]);
  await page.goto("/console/providers/antigravity");
  await expect.poll(() => mock.controls.quotaCalls).toBe(1);
  const reads = mock.controls.accountListCalls;
  await expect
    .poll(() => mock.controls.accountListCalls, { timeout: 10000 })
    .toBeGreaterThan(reads);
  expect(mock.controls.quotaCalls).toBe(1);
  Object.assign(
    mock.accounts.get(pending.account_ref)!,
    account(pending.account_ref, pending.provider_id),
    { project_initialization: null },
  );
  await expect.poll(() => mock.controls.quotaCalls, { timeout: 10000 }).toBe(2);
});

test("age and account verification links are available on the account card and authorization dialog", async ({
  page,
}) => {
  const pending = account();
  const challenge =
    "https://accounts.google.com/signin/continue?authuser=1&state=challenge%2Bvalue";
  pending.status = "initializing";
  pending.project_id = null;
  pending.project_initialization = {
    status: "error",
    next_retry_at: null,
    error: "Account verification is required.",
    verification: [
      {
        reason: "RESTRICTED_AGE",
        message: "Verify your age to use Antigravity.",
        url: "https://myaccount.google.com/age-verification",
        learn_more_url: null,
      },
      {
        reason: "VALIDATION_REQUIRED",
        message: "Complete Google's account verification.",
        url: challenge,
        learn_more_url: "https://support.google.com/accounts?p=al_alert",
      },
    ],
  };
  await mockApi(page, configured([pending]));
  const mock = await mockOAuth(page, [pending]);
  await page.goto("/console/providers/antigravity");
  await expect(
    page.getByRole("link", { name: "Verify age", exact: true }),
  ).toHaveAttribute("href", "https://myaccount.google.com/age-verification");
  await expect(
    page.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveAttribute("href", challenge);
  await expect(
    page.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Complete Google's account verification."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveAttribute("href", challenge);
  await expect(
    dialog.getByRole("link", { name: "Learn more", exact: true }),
  ).toHaveAttribute("href", "https://support.google.com/accounts?p=al_alert");
  await dialog
    .getByRole("button", { name: "Retry project initialization", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveCount(0);
  expect(mock.controls.projectRetries).toBe(1);
  expect(mock.controls.starts).toHaveLength(0);
});

test("quota verification shows the Google action and credit balances preserve zero and large integers", async ({
  page,
}) => {
  const ready = account();
  const challenge =
    "https://accounts.google.com/signin/continue?state=quota-challenge";
  ready.quota = {
    ...ready.quota,
    last_error:
      "retrieveUserQuotaSummary failed (HTTP 503) Verify your account to continue.",
    verification: [
      {
        reason: "VALIDATION_REQUIRED",
        message: "Verify your account to continue.",
        url: challenge,
        learn_more_url: null,
      },
    ],
    subscription: {
      tier_id: "pro",
      tier_name: "Pro",
      credits: [
        { type: "GOOGLE_ONE_AI", amount: "0" },
        { type: "Bonus credits", amount: "9007199254740993" },
      ],
    },
  };
  await mockApi(page, configured([ready]));
  await mockOAuth(page, [ready]);
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}/quota`,
    (route) => route.fulfill({ json: ready }),
  );
  await page.goto("/console/providers/antigravity");
  await expect(
    page.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveAttribute("href", challenge);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "retrieveUserQuotaSummary failed (HTTP 503)" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Verify your account to continue." }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Google One AI credits: 0", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Bonus credits: 9007199254740993", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Credit spending is disabled.")).toBeVisible();
  await expect(page.getByText(/Available credits:.*Unknown/)).toHaveCount(0);
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}/quota`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Quota refresh temporarily unavailable" },
      }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Quota refresh temporarily unavailable" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Verify your account to continue." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveAttribute("href", challenge);
  ready.quota.verification = undefined;
  ready.quota.last_error = null;
  ready.quota.subscription!.credits = [];
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}/quota`,
    (route) => route.fulfill({ json: ready }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Verify account", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Credit spending is disabled.")).toHaveCount(0);
});

test("settings save before the first account and subsequent authorization inherits the selected proxy", async ({
  page,
}) => {
  const initial = draftFixture();
  initial.config.proxy_groups.push({
    id: "google-egress",
    strategy: "sticky",
    proxies: [
      {
        id: "node",
        url: "socks5://proxy.example:1080",
        priority: 100,
        disabled: false,
      },
    ],
  });
  const api = await mockApi(page, initial);
  const mock = await mockOAuth(page);
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("switch", { name: "Provider enabled", exact: true }),
  ).not.toBeChecked();
  await dialog.getByLabel("Priority", { exact: true }).fill("250");
  await dialog
    .getByRole("combobox", { name: "Proxy group", exact: true })
    .click();
  await page
    .getByRole("option", { name: "google-egress · sticky", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    api
      .current()
      .config.providers.find((provider) => provider.type === "antigravity"),
  ).toMatchObject({
    id: expect.any(String),
    priority: 250,
    proxy_group: "google-egress",
    disabled: true,
    models: [],
    credentials: [],
  });
  expect(api.current().version).toBe(2);
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  await authorize(dialog);
  expect(mock.controls.starts[0]).toMatchObject({
    provider_id: expect.any(String),
    provider_proxy_group: "google-egress",
    version: 2,
  });
  expect(mock.controls.starts[0]).not.toHaveProperty("credential_proxy_group");
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    api
      .current()
      .config.providers.find((provider) => provider.type === "antigravity"),
  ).toMatchObject({
    priority: 250,
    proxy_group: "google-egress",
    models: [],
    credentials: [
      { auth: { type: "oauth", account_ref: [...mock.accounts.keys()][0] } },
    ],
  });
});

test("authorization errors remain retryable and models are selected in separate provider settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = await mockApi(page, configured([]));
  const mock = await mockOAuth(page);
  mock.controls.failCallback = true;
  await page.goto("/console/providers/antigravity");
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Authorize with Google", exact: true })
    .click();
  const callback = dialog.getByLabel("Localhost callback URL");
  await callback.fill(
    "http://localhost:51121/oauth-callback?code=test&state=wrong",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Invalid callback URL or OAuth state", { exact: true }),
  ).toBeVisible();
  await expect(callback).toHaveValue(/state=wrong/);
  await expect(
    dialog.getByRole("button", { name: "Save account", exact: true }),
  ).toBeDisabled();
  await callback.fill(
    "http://localhost:51121/oauth-callback?code=test&state=e2e-state",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Authorization: complete", { exact: true }),
  ).toBeVisible();
  await expect(callback).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    api
      .current()
      .config.providers.find((provider) => provider.type === "antigravity"),
  ).toMatchObject({
    disabled: true,
    models: [],
    credentials: [
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        auth: { account_ref: [...mock.accounts.keys()][0] },
      },
    ],
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await dialog
    .getByRole("switch", { name: "Provider enabled", exact: true })
    .check();
  await dialog.getByRole("tab", { name: "Models", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /Gemini real/ }).check();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = api
    .current()
    .config.providers.find((provider) => provider.type === "antigravity");
  expect(saved?.models).toEqual(["gemini-real"]);
  expect(saved?.disabled).toBe(false);
  expect(saved?.credentials[0].auth.type).toBe("oauth");
  expect(JSON.stringify(saved)).not.toMatch(
    /test-code|rowId|access_token|refresh_token|verifier/,
  );
  expect(
    api
      .current()
      .config.providers.filter((provider) => provider.type === "antigravity"),
  ).toHaveLength(1);
  expect(api.current().version).toBe(3);
  expect(mock.controls.starts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a failed account save retains the authorization and can retry without another OAuth exchange", async ({
  page,
}) => {
  const api = await mockApi(page, configured([]));
  const mock = await mockOAuth(page);
  await page.goto("/console/providers/antigravity");
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await authorize(dialog);
  await dialog.getByLabel("Account priority", { exact: true }).fill("75");
  let fail = true;
  await page.route("**/console/api/**", async (route) => {
    if (isConfigurationMutation(route.request()) && fail) {
      fail = false;
      await route.fulfill({
        status: 409,
        json: { error: "The draft changed; reload before saving" },
      });
    } else await route.fallback();
  });
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(
    dialog.getByText("The draft changed; reload before saving", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Account priority", { exact: true }),
  ).toHaveValue("75");
  await expect(
    dialog.getByText("Authorization: complete", { exact: true }),
  ).toBeVisible();
  expect(api.current().version).toBe(1);
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = api
    .current()
    .config.providers.find((provider) => provider.type === "antigravity");
  expect(saved?.credentials[0]).toMatchObject({
    priority: 75,
    auth: { account_ref: [...mock.accounts.keys()][0] },
  });
  expect(mock.controls.starts).toHaveLength(1);
  expect(mock.controls.callbackCalls).toBe(1);
});

test("settings preserve accounts, stable route rows and retry edits after a failed save", async ({
  page,
}) => {
  const ready = account();
  const initial = configured([ready]);
  const api = await mockApi(page, initial);
  await mockOAuth(page, [ready]);
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Priority", { exact: true }).fill("300");
  await dialog
    .getByRole("tab", { name: "Routing & retry", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add model route", exact: true })
    .click();
  await dialog.getByLabel("Client model name", { exact: true }).fill("discard");
  await dialog
    .getByRole("button", { name: "Add model route", exact: true })
    .click();
  await dialog
    .getByLabel("Client model name", { exact: true })
    .nth(1)
    .fill("native-alias");
  await dialog
    .getByRole("button", { name: "Remove route 1", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Client model name", { exact: true }),
  ).toHaveValue("native-alias");
  await dialog
    .getByRole("button", { name: "Enable retries", exact: true })
    .click();
  await dialog
    .getByLabel("Retry HTTP status codes", { exact: true })
    .fill("429, 503");
  await dialog
    .getByLabel("Retry delays (milliseconds)", { exact: true })
    .fill("1000, 2000");
  let fail = true;
  await page.route("**/console/api/**", async (route) => {
    if (isConfigurationMutation(route.request()) && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Configuration save temporarily unavailable" },
      });
    } else await route.fallback();
  });
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    dialog.getByText("Configuration save temporarily unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Client model name", { exact: true }),
  ).toHaveValue("native-alias");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = api
    .current()
    .config.providers.find((provider) => provider.type === "antigravity");
  expect(saved).toMatchObject({
    priority: 300,
    model_routes: { "native-alias": { model: model.id } },
    retry: { status_codes: [429, 503], delays_ms: [1000, 2000] },
  });
  expect(saved?.credentials).toEqual(initial.config.providers[1].credentials);
  expect(JSON.stringify(saved)).not.toMatch(/rowId/);

  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await dialog.getByLabel("Account priority", { exact: true }).fill("50");
  await dialog
    .getByRole("switch", { name: "Account enabled", exact: true })
    .uncheck();
  await dialog
    .getByRole("combobox", { name: "Proxy group", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Direct connection", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const edited = api
    .current()
    .config.providers.find((provider) => provider.type === "antigravity");
  expect(edited).toMatchObject({
    priority: saved?.priority,
    models: saved?.models,
    model_routes: saved?.model_routes,
    retry: saved?.retry,
    credentials: [
      {
        id: "account-1",
        priority: 50,
        disabled: true,
        proxy_group: null,
        auth: { account_ref: ready.account_ref },
      },
    ],
  });
});

test("account ordering saves independently and failed reorder operations can be retried", async ({
  page,
}) => {
  const accounts = [account(), account()];
  const initial = configured(accounts);
  const api = await mockApi(page, initial);
  await mockOAuth(page, accounts);
  await page.goto("/console/providers/antigravity");
  const rows = page.locator("[data-account-id]");
  await expect(rows).toHaveCount(2);
  let fail = true;
  await page.route("**/console/api/**", async (route) => {
    if (isConfigurationMutation(route.request()) && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Reorder temporarily unavailable" },
      });
    } else await route.fallback();
  });
  await rows
    .nth(1)
    .getByRole("button", { name: /Account actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(
    page
      .locator("#main-content")
      .getByText("Reorder temporarily unavailable", { exact: true }),
  ).toBeVisible();
  await expect(rows.first()).toHaveAttribute("data-account-id", "account-1");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(rows.first()).toHaveAttribute("data-account-id", "account-2");
  expect(api.current().config.providers[1].credentials).toEqual(
    [...initial.config.providers[1].credentials].reverse(),
  );
  await rows
    .first()
    .getByRole("button", { name: /Account actions/ })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Move up", exact: true }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect(rows.first()).toHaveAttribute("data-account-id", "account-1");
});

test("removing a draft account keeps authorization available for recovery", async ({
  page,
}) => {
  const ready = account();
  const api = await mockApi(page, configured([ready]));
  const mock = await mockOAuth(page, [ready]);
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: /Account actions/ }).click();
  await page
    .getByRole("menuitem", { name: "Remove account", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove account", exact: true })
    .click();
  await expect(page.locator("[data-account-id]")).toHaveCount(0);
  expect(api.current().config.providers[1].credentials).toEqual([]);
  expect(mock.controls.disconnects).toEqual([]);
  await page
    .getByRole("button", { name: "Add Google account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", {
      name: "Use an existing account for this provider",
      exact: true,
    })
    .click();
  await page.getByRole("option", { name: new RegExp(ready.email!) }).click();
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(api.current().config.providers[1].credentials[0].auth).toEqual({
    type: "oauth",
    account_ref: ready.account_ref,
  });
  expect(mock.controls.starts).toEqual([]);
});

test("pending settings saves lock the form and keep the editing snapshot open", async ({
  page,
}) => {
  const ready = account();
  const api = await mockApi(page, configured([ready]));
  await mockOAuth(page, [ready]);
  const delayed = deferred<Route>();
  await page.route("**/console/api/**", async (route) => {
    if (isConfigurationMutation(route.request())) delayed.resolve(route);
    else await route.fallback();
  });
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Priority", { exact: true }).fill("400");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const pending = await delayed.promise;
  await expect(dialog.getByLabel("Priority", { exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await pending.fallback();
  await expect(dialog).toBeHidden();
  expect(api.current().config.providers[1].priority).toBe(400);
});

test("quota refresh failures preserve last success and can be retried", async ({
  page,
}) => {
  const ready = account();
  await mockApi(page, configured([ready]));
  const mock = await mockOAuth(page, [ready]);
  await page.goto("/console/providers/antigravity");
  await expect(page.getByText("75% left", { exact: true })).toBeVisible();
  mock.controls.failQuota = true;
  await page.getByRole("button", { name: "Refresh all", exact: true }).click();
  await expect(
    page.getByText(/Quota refresh temporarily unavailable/),
  ).toBeVisible();
  await expect(page.getByText("75% left", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale", { exact: true })).toBeVisible();
  mock.controls.failQuota = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
});

test("quotas refresh only on demand, including after focus and reconnect", async ({
  page,
}) => {
  const ready = account();
  await mockApi(page, configured([ready]));
  const mock = await mockOAuth(page, [ready]);
  await page.clock.install();
  await page.goto("/console/providers/antigravity");
  await expect(page.getByText("75% left", { exact: true })).toBeVisible();
  const initial = mock.controls.quotaCalls;
  await page.clock.fastForward(300001);
  expect(mock.controls.quotaCalls).toBe(initial);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await page.clock.fastForward(300001);
  expect(mock.controls.quotaCalls).toBe(initial);
  await page.getByRole("button", { name: "Refresh all", exact: true }).click();
  await expect.poll(() => mock.controls.quotaCalls).toBe(initial + 1);
});

test("a late account read cannot undo a successful disconnect", async ({
  page,
}) => {
  const ready = account();
  await mockApi(page, configured([ready]));
  await mockOAuth(page, [ready]);
  let holdRead = false;
  let heldRead = false;
  const delayed = deferred<Route>();
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}`,
    async (route) => {
      if (holdRead && route.request().method() === "GET") {
        holdRead = false;
        heldRead = true;
        delayed.resolve(route);
      } else await route.fallback();
    },
  );
  await page.clock.install();
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeEnabled();
  holdRead = true;
  await page.clock.fastForward(15_001);
  // Reopening the editor refreshes stale data; focus changes no longer fetch.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect.poll(() => heldRead).toBe(true);
  const oldRead = await delayed.promise;
  const finished = deferred<void>();
  const finishRead = (request: BrowserRequest) => {
    if (request === oldRead.request()) finished.resolve();
  };
  page.on("requestfinished", finishRead);
  page.on("requestfailed", finishRead);
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect account", exact: true })
    .click();
  await expect(dialog.getByText("disconnected", { exact: true })).toBeVisible();
  await oldRead.fulfill({ json: ready });
  await finished.promise;
  // Allow the response parser and React's next paint to consume the late response.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(dialog.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeDisabled();
});

test("a slow bulk quota refresh cannot restore an account disconnected in the editor", async ({
  page,
}) => {
  const ready = account();
  await mockApi(page, configured([ready]));
  const mock = await mockOAuth(page, [ready]);
  await page.goto("/console/providers/antigravity");
  await expect(page.getByText("75% left", { exact: true })).toBeVisible();
  const oldSnapshot = structuredClone(mock.accounts.get(ready.account_ref));
  const delayed = deferred<Route>();
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}/quota`,
    (route) => delayed.resolve(route),
  );
  await page.getByRole("button", { name: "Refresh all", exact: true }).click();
  const pending = await delayed.promise;
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect account", exact: true })
    .click();
  await expect(dialog.getByText("disconnected", { exact: true })).toBeVisible();
  const finished = page.waitForEvent(
    "requestfinished",
    (request) => request === pending.request(),
  );
  await pending.fulfill({ json: oldSnapshot });
  await finished;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog.getByText("disconnected", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeDisabled();
});

test("Gemini models are grouped while level selections save physical IDs and routes target the family", async ({
  page,
}) => {
  const ready = account();
  const family = "gemini-3.8-flash";
  const variants = ["low", "medium", "high"].map(
    (level) => `${family}-${level}`,
  );
  ready.models = variants.map((id) => ({ ...model, id, display_name: id }));
  const initial = configured([ready]);
  const provider = initial.config.providers.find(
    (entry) => entry.type === "antigravity",
  )!;
  provider.models = [variants[2]];
  const api = await mockApi(page, initial);
  await mockOAuth(page, [ready]);
  await page.goto("/console/providers/antigravity");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(
    dialog.getByText("gemini-3.8-flash", { exact: true }),
  ).toHaveCount(1);
  await dialog.getByText("Thinking levels: high", { exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "gemini-3.8-flash low", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "gemini-3.8-flash high",
      exact: true,
    }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "gemini-3.8-flash medium", exact: true })
    .check();
  await dialog
    .getByRole("tab", { name: "Routing & retry", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add model route", exact: true })
    .click();
  await dialog.getByLabel("Client model name", { exact: true }).fill("flash");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = api
    .current()
    .config.providers.find((entry) => entry.type === "antigravity")!;
  expect(saved.models).toEqual([variants[2], variants[1]]);
  expect(saved.model_routes).toMatchObject({ flash: { model: family } });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await dialog.getByRole("tab", { name: "Models", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "gemini-3.8-flash", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    api
      .current()
      .config.providers.find((entry) => entry.type === "antigravity")
      ?.models.toSorted(),
  ).toEqual(variants.toSorted());
  await page.goto("/console/routing");
  await page.getByRole("button", { name: "Add route", exact: true }).click();
  await dialog
    .getByLabel("Client model name", { exact: true })
    .fill("public-flash");
  await dialog.getByLabel("Model", { exact: true }).click();
  await page
    .getByRole("option", { name: "gemini-3.8-flash", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: saved.name ?? saved.id, exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save route", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.current().config.model_routes["public-flash"]).toMatchObject({
    model: family,
    providers: [saved.id],
  });
});

test("Model pricing has one Gemini family and saves one price and context for all levels", async ({
  page,
}) => {
  const ready = account();
  const family = "gemini-3.8-flash";
  const variants = ["low", "medium", "high"].map(
    (level) => `${family}-${level}`,
  );
  ready.models = variants.map((id) => ({ ...model, id, display_name: id }));
  ready.quota.groups = variants.map((id, index) => ({
    id,
    label: id,
    buckets: [
      {
        id: "model",
        label: "Remaining",
        window: null,
        remaining_fraction: (index + 1) / 4,
        reset_at: null,
      },
    ],
  }));
  const initial = configured([ready]);
  const provider = initial.config.providers.find(
    (entry) => entry.type === "antigravity",
  )!;
  provider.models = variants;
  provider.model_settings = Object.fromEntries(
    variants.map((name) => [name, { id: crypto.randomUUID() }]),
  );
  const api = await mockApi(page, initial);
  await mockOAuth(page, [ready]);
  await page.route(
    `**/console/api/provider-accounts/${ready.account_ref}/quota`,
    (route) => route.fulfill({ json: ready }),
  );
  await page.goto(`/console/pricing?provider=${provider.id}`);
  await expect(
    page.getByRole("button", { name: /gemini-3.8-flash/ }),
  ).toHaveCount(1);
  for (const name of variants)
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  await page.getByLabel("Context window (tokens)").fill("1000000");
  await page
    .getByRole("button", { name: "Save model settings", exact: true })
    .click();
  await expect
    .poll(() =>
      Object.values(
        api
          .current()
          .config.providers.find((entry) => entry.id === provider.id)!
          .model_settings!,
      ).map((entry) => entry.context_window),
    )
    .toEqual([1000000, 1000000, 1000000]);
  await page
    .getByRole("button", { name: "Configure prices", exact: true })
    .click();
  await page.getByLabel("Input", { exact: true }).fill("2");
  await page.getByLabel("Output", { exact: true }).fill("8");
  await page.getByLabel("Cache write", { exact: true }).fill("0");
  await page.getByLabel("Cache read", { exact: true }).fill("0");
  await page
    .getByRole("button", { name: "Save model price", exact: true })
    .click();
  await expect
    .poll(
      () =>
        api
          .current()
          .config.model_prices?.filter(
            (price) => price.provider_id === provider.id,
          ).length,
    )
    .toBe(3);
  expect(
    api
      .current()
      .config.model_prices!.filter((price) => price.provider_id === provider.id)
      .every(
        (price) =>
          price.pricing?.tiers[0].input === "2" &&
          price.pricing.tiers[0].output === "8",
      ),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /gemini-3.8-flash/ }),
  ).toHaveCount(1);
  await expect(page.getByLabel("Input", { exact: true })).toHaveValue("2");
  await page.goto("/console/providers/antigravity");
  const quota = page.getByLabel("Account quota");
  await expect(
    quota.getByText("gemini-3.8-flash", { exact: true }),
  ).toHaveCount(1);
  for (const name of variants)
    await expect(quota.getByText(name, { exact: true })).toHaveCount(0);
  await expect(quota.getByText("25% left", { exact: true })).toBeVisible();
  await expect(quota.getByText("75% left", { exact: true })).toBeVisible();
  await page.goto("/console/overview");
  await page.getByLabel("Filter by model", { exact: true }).click();
  await expect(
    page.getByRole("option", { name: "gemini-3.8-flash", exact: true }),
  ).toHaveCount(1);
  for (const name of variants)
    await expect(page.getByRole("option", { name, exact: true })).toHaveCount(
      0,
    );
});
