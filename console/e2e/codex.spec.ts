import { expect, test, type Page } from "@playwright/test";
import type { ConfigurationView } from "./fixtures";
import { codexProviderSchema } from "../../src/config/schema";
import {
  accountViewSchema,
  type AccountHealth,
  type AccountView,
  type SessionView,
} from "../../src/providers/oauth/schema";
import { draftFixture, mockApi } from "./fixtures";

const hour = 3_600_000;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function account(ref: string = crypto.randomUUID(), ready = true): AccountView {
  return accountViewSchema.parse({
    account_ref: ref,
    provider_id: "codex",
    status: ready ? "ready" : "authorizing",
    email: ready ? `chatgpt-${ref.slice(0, 4)}@example.test` : null,
    project_id: null,
    codex: ready
      ? {
          account_id: `acct-${ref.slice(0, 4)}`,
          user_id: null,
          plan_type: "prolite",
          subscription_active_until: new Date(
            Date.now() + 20 * 24 * hour,
          ).toISOString(),
        }
      : null,
    expires_at: ready ? Date.now() + hour : null,
    error: null,
    models: ready
      ? [
          {
            id: "gpt-5.5-codex",
            display_name: "GPT-5.5 Codex",
            input_token_limit: 272000,
            output_token_limit: 128000,
          },
        ]
      : [],
    models_updated_at: ready ? Date.now() : null,
    models_error: null,
    quota: {
      groups: ready
        ? [
            {
              id: "rate_limit",
              label: "Codex",
              buckets: [
                {
                  id: "primary",
                  label: "5h",
                  window: "5h",
                  remaining_fraction: 0.12,
                  reset_at: new Date(Date.now() + 2 * hour).toISOString(),
                },
                {
                  id: "secondary",
                  label: "Weekly",
                  window: "weekly",
                  remaining_fraction: 0.8,
                  reset_at: new Date(Date.now() + 72 * hour).toISOString(),
                },
              ],
            },
          ]
        : [],
      subscription: null,
      updated_at: ready ? Date.now() : null,
      stale: false,
      last_error: null,
      reset_credits: ready
        ? {
            available_count: 2,
            credits: [
              {
                id: "credit-late",
                reset_type: "rate_limit",
                status: "available",
                granted_at: null,
                expires_at: new Date(Date.now() + 30 * 24 * hour).toISOString(),
                title: "Late reset",
                description: null,
              },
              {
                id: "credit-soon",
                reset_type: "rate_limit",
                status: "available",
                granted_at: null,
                expires_at: new Date(Date.now() + 3 * 24 * hour).toISOString(),
                title: "Soon reset",
                description: null,
              },
            ],
            updated_at: Date.now(),
            error: null,
          }
        : null,
    },
  });
}

function configured(accounts: AccountView[]): ConfigurationView {
  const draft: ConfigurationView = draftFixture();
  draft.config.providers.push(
    codexProviderSchema.parse({
      id: "codex",
      type: "codex",
      priority: 100,
      disabled: !accounts.length,
      models: ["gpt-5.5-codex"],
      credentials: accounts.map((value, index) => ({
        id: `account-${index + 1}`,
        auth: { type: "oauth", account_ref: value.account_ref },
        priority: 100,
        disabled: false,
      })),
    }),
  );
  return draft;
}

async function mockCodex(page: Page, initial: AccountView[] = []) {
  const accounts = new Map(
    initial.map((value) => [value.account_ref, structuredClone(value)]),
  );
  const sessions = new Map<string, SessionView>();
  const controls = {
    health: new Array<AccountHealth>(),
    starts: new Array<Record<string, unknown>>(),
    consumes: new Array<Record<string, unknown>>(),
    polls: 0,
    callbacks: new Array<Record<string, unknown>>(),
    planUsageEnabled: true,
    modelRefreshes: new Array<Record<string, unknown>>(),
    failCallback: false,
    failStart: false,
    failModels: false,
    holdCallback: false,
    callbackStarted: gate(),
    callbackRelease: gate(),
  };
  await page.route(
    (url) => url.pathname.startsWith("/console/api/oauth/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/sessions")) {
        const input: Record<string, unknown> = request.postDataJSON();
        controls.starts.push(input);
        if (controls.failStart) {
          await route.fulfill({
            status: 503,
            json: { error: "Authorization temporarily unavailable" },
          });
          return;
        }
        const ref =
          typeof input.account_ref === "string"
            ? input.account_ref
            : crypto.randomUUID();
        const view = accounts.get(ref) ?? account(ref, false);
        accounts.set(ref, view);
        const device = input.flow === "device";
        let flow: SessionView["flow"] = "pkce";
        if (input.flow === "siwc_bind") flow = "siwc_bind";
        else if (device) flow = "device";
        const session: SessionView = {
          id: `${ref}.${crypto.randomUUID()}`,
          account_ref: ref,
          status: "pending",
          expires_at: Date.now() + 900_000,
          url: device
            ? "https://auth.openai.com/codex/device"
            : "https://auth.openai.com/oauth/authorize?state=e2e-state",
          flow,
          user_code: device ? "ABCD-1234" : null,
          verification_uri: device
            ? "https://auth.openai.com/codex/device"
            : null,
          error: null,
          can_retry: false,
          account: view,
        };
        sessions.set(session.id, session);
        await route.fulfill({ json: session });
        return;
      }
      const session = sessions.get(decodeURIComponent(path.split("/")[5]));
      if (!session) {
        await route.fulfill({
          status: 404,
          json: { error: "Missing session" },
        });
        return;
      }
      if (
        request.method() === "POST" &&
        path.endsWith("/callback") &&
        session.flow === "siwc_bind"
      ) {
        controls.callbacks.push(request.postDataJSON());
        if (controls.failCallback) {
          await route.fulfill({
            status: 400,
            json: { error: "Invalid callback state" },
          });
          return;
        }
        if (controls.holdCallback) {
          const delayed = {
            ...structuredClone(session),
            status: "initializing",
            url: null,
          };
          controls.callbackStarted.resolve();
          await controls.callbackRelease.promise;
          await route.fulfill({ json: delayed });
          return;
        }
        const ready = {
          ...session.account,
          siwc: siwcAccount(session.account_ref, controls.planUsageEnabled)
            .siwc,
        };
        accounts.set(ready.account_ref, ready);
        session.account = ready;
        session.status = "complete";
        session.url = null;
      }
      if (request.method() === "DELETE") {
        session.status = "cancelled";
        session.url = null;
      }
      // The device grant completes on the first poll, as the alarm would after approval.
      if (
        request.method() === "GET" &&
        session.flow === "device" &&
        ++controls.polls >= 1
      ) {
        const ready = account(session.account_ref);
        accounts.set(ready.account_ref, ready);
        session.account = ready;
        session.status = "complete";
        session.url = null;
        session.user_code = null;
      }
      await route.fulfill({ json: session });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/console/api/provider-accounts"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/console/api/provider-accounts") {
        await route.fulfill({
          json: {
            items: [...accounts.values()].filter(
              (value) =>
                value.provider_id === url.searchParams.get("provider_id"),
            ),
          },
        });
        return;
      }
      if (url.pathname === "/console/api/provider-accounts/health") {
        await route.fulfill({ json: { items: controls.health } });
        return;
      }
      const value = accounts.get(url.pathname.split("/")[4]);
      if (!value) {
        await route.fulfill({
          status: 404,
          json: { error: "Unknown account" },
        });
        return;
      }
      if (url.pathname.endsWith("/models")) {
        const input = request.postDataJSON();
        controls.modelRefreshes.push(input);
        if (controls.failModels && input.mode === "siwc") {
          if (value.siwc)
            value.siwc.models_error = "Public catalog unavailable";
          await route.fulfill({
            status: 503,
            json: { error: "Model discovery unavailable" },
          });
          return;
        }
      }
      if (url.pathname.endsWith("/reset-credits/consume")) {
        controls.consumes.push(request.postDataJSON());
        const credits = value.quota.reset_credits;
        if (credits) {
          credits.credits = credits.credits.filter(
            (credit) => credit.id !== "credit-soon",
          );
          credits.available_count = credits.credits.length;
        }
        value.quota.groups[0]?.buckets.forEach((bucket) => {
          bucket.remaining_fraction = 1;
        });
        controls.health = [];
        await route.fulfill({
          json: { result: { code: "reset", windows_reset: 1 }, account: value },
        });
        return;
      }
      await route.fulfill({ json: value });
    },
  );
  return controls;
}

test("Codex is a provider page with balancing settings", async ({ page }) => {
  await mockApi(page);
  await mockCodex(page);
  await page.goto("/console/providers");
  await page.getByRole("link", { name: "Codex", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Codex", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No ChatGPT accounts" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Account selection" }).click();
  await page
    .getByRole("option", { name: "Session affinity (fill first)" })
    .click();
  await expect(dialog.getByLabel("Use resets automatically")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Account selection" }),
  ).toHaveText("Session affinity (fill first)");
});

test("account cards show plan, quota and cooldown, and spend a reset after confirmation", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  controls.health = [
    {
      credential_id: "account-1",
      account_ref: value.account_ref,
      available: false,
      cooling_until: Date.now() + 2 * hour,
      cooldown_reason: "quota",
    },
  ];
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await expect(card.getByText(value.email ?? "")).toBeVisible();
  await expect(card.getByText("Pro 5x", { exact: true })).toBeVisible();
  await expect(card.getByText("12% left")).toBeVisible();
  await expect(card.getByText("80% left")).toBeVisible();
  await expect(card.getByText("2 resets")).toBeVisible();
  await expect(card.getByText("Exhausted", { exact: true })).toBeVisible();
  await expect(card.getByText(/back in/)).toHaveCount(0);

  await card.getByRole("button", { name: "Reset (2)" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText(/cannot be undone/)).toBeVisible();
  await expect(
    confirm.getByRole("listitem").first().getByText("Next"),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Spend 1 reset" }).click();
  await expect(confirm).toBeHidden();
  expect(controls.consumes).toHaveLength(1);
  expect(controls.consumes[0]).toMatchObject({ credit_id: "credit-soon" });
  expect(controls.consumes[0]?.redeem_request_id).toEqual(expect.any(String));
  await expect(card.getByText("1 reset", { exact: true })).toBeVisible();
  await expect(card.getByText("Available", { exact: true })).toBeVisible();
});

test("quota bars preserve fractional values and distinguish unknown from exhausted", async ({
  page,
}) => {
  const value = account();
  value.quota.groups[0]!.buckets = [
    { label: "Nearly empty", remaining_fraction: 0.004 },
    { label: "Below warning threshold", remaining_fraction: 0.196 },
    { label: "At warning threshold", remaining_fraction: 0.2 },
    { label: "Exhausted", remaining_fraction: 0 },
    { label: "Unknown", remaining_fraction: null },
    { label: "Full", remaining_fraction: 1 },
  ].map((bucket) => ({
    ...bucket,
    id: bucket.label,
    window: null,
    reset_at: null,
  }));
  await mockApi(page, configured([value]));
  await mockCodex(page, [value]);
  await page.goto("/console/providers/codex");

  const bar = (label: string) =>
    page.getByRole("progressbar", { name: `Codex ${label} remaining` });
  const nearlyEmpty = bar("Nearly empty");
  await expect(nearlyEmpty).toHaveAttribute("aria-valuenow", "0.4");
  await expect(nearlyEmpty).toHaveAttribute("aria-valuetext", "<1% left");
  await expect(page.getByText("<1% left", { exact: true })).toBeVisible();
  await expect(bar("Below warning threshold")).toHaveAttribute(
    "aria-valuenow",
    "19.6",
  );
  await expect(bar("At warning threshold")).toHaveAttribute(
    "aria-valuenow",
    "20",
  );
  await expect(bar("Exhausted")).toHaveAttribute("aria-valuenow", "0");
  await expect(bar("Exhausted")).toHaveAttribute("aria-valuetext", "0% left");
  await expect(bar("Unknown")).not.toHaveAttribute("aria-valuenow");
  await expect(bar("Unknown")).toHaveAttribute("aria-valuetext", "Unknown");
  await expect(bar("Full")).toHaveAttribute("aria-valuenow", "100");

  const color = (label: string) =>
    bar(label)
      .locator('[data-slot="progress-indicator"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await color("Below warning threshold")).toBe(
    await color("Nearly empty"),
  );
  expect(await color("At warning threshold")).not.toBe(
    await color("Below warning threshold"),
  );
  expect(await color("Exhausted")).not.toBe(await color("Nearly empty"));
});

test("a ChatGPT account authorizes with a device code", async ({ page }) => {
  await mockApi(page, configured([]));
  const controls = await mockCodex(page);
  await page.goto("/console/providers/codex");
  await page
    .getByRole("button", { name: "Add ChatGPT account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("tab", { name: "Device code", selected: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Authorize with ChatGPT", exact: true })
    .click();
  await expect(dialog.getByLabel("Device code", { exact: true })).toHaveText(
    "ABCD-1234",
  );
  await expect(
    dialog.getByRole("link", { name: "Open ChatGPT device sign-in" }),
  ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(controls.starts[0]).toMatchObject({
    provider_id: "codex",
    flow: "device",
  });
  await expect(
    dialog.getByText("Authorization: complete", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-account-id]")).toHaveCount(1);
});

test("the paste flow asks for the localhost callback", async ({ page }) => {
  await mockApi(page, configured([]));
  const controls = await mockCodex(page);
  await page.goto("/console/providers/codex");
  await page
    .getByRole("button", { name: "Add ChatGPT account", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Paste callback URL" }).click();
  await dialog
    .getByRole("button", { name: "Authorize with ChatGPT", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Open ChatGPT authorization" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Localhost callback URL")).toHaveAttribute(
    "placeholder",
    /localhost:1455\/auth\/callback/,
  );
  expect(controls.starts[0]).toMatchObject({ flow: "pkce" });
});

test("retrying a reset keeps the original credit and idempotency key after a list refresh", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  await mockCodex(page, [value]);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/reset-credits/consume", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "Response unavailable" },
      });
    } else {
      await route.fulfill({
        json: {
          result: { code: "already_redeemed", windows_reset: 0 },
          account: value,
        },
      });
    }
  });
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card.getByRole("button", { name: "Reset (2)" }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Spend 1 reset" }).click();
  await expect(confirm.getByText("Response unavailable")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  const changed = structuredClone(value);
  if (changed.quota.reset_credits)
    changed.quota.reset_credits.credits =
      changed.quota.reset_credits.credits.filter(
        (credit) => credit.id !== "credit-soon",
      );
  await page.route("**/reset-credits", (route) =>
    route.fulfill({ json: changed }),
  );
  await card.getByRole("button", { name: "Reset (2)" }).click();
  await expect(
    confirm.getByText("1 of 1 credit available.", { exact: false }),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Retry reset" }).click();
  await expect(confirm).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]?.credit_id).toBe("credit-soon");
});

function siwcAccount(
  ref: string = crypto.randomUUID(),
  enabled = true,
): AccountView {
  const view = account(ref);
  view.siwc = {
    generation: 1,
    status: "ready",
    email: view.email,
    expires_at: Date.now() + 3600_000,
    plan_usage_enabled: enabled,
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
  };
  return view;
}

test("SIWC signs in beside the account switch and binds before any configuration save", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  const credentialWrites: string[] = [];
  const accountReads: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/credentials"))
      credentialWrites.push(request.url());
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname ===
        `/console/api/provider-accounts/${value.account_ref}`
    )
      accountReads.push(request.url());
  });
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  const header = card.locator('[data-slot="card-header"]');
  await header
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("127.0.0.1 callback URL")).toBeVisible();
  expect(controls.starts).toHaveLength(1);
  expect(accountReads).toHaveLength(0);
  expect(controls.starts[0]).toMatchObject({
    flow: "siwc_bind",
    account_ref: value.account_ref,
    credential_id: "account-1",
    version: 1,
  });
  await dialog
    .getByLabel("127.0.0.1 callback URL")
    .fill(
      "http://127.0.0.1:1455/auth/callback?code=test&state=e2e-state&client_id=oaiapp_test",
    );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "You’re using your ChatGPT plan",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(header.getByText("SIWC", { exact: true })).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Sign in with ChatGPT", exact: true }),
  ).toHaveCount(0);
  expect(credentialWrites).toHaveLength(0);
  await page.reload();
  await expect(header.getByText("SIWC", { exact: true })).toBeVisible();
  await expect(page.locator("[data-account-id]")).toHaveCount(1);
  expect(credentialWrites).toHaveLength(0);
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: /Use SIWC/ })).toHaveCount(0);
  await expect(
    dialog.getByRole("tab", { name: "Device code", exact: true }),
  ).toBeEnabled();
});

test("authorized cards show only the SIWC badge and Use SIWC is saved globally", async ({
  page,
}) => {
  const values = [siwcAccount(), account()];
  await mockApi(page, configured(values));
  await mockCodex(page, values);
  const credentials: string[] = [];
  const settings: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET") return;
    if (request.url().includes("/credentials")) credentials.push(request.url());
    if (request.url().includes("/native-providers/codex"))
      settings.push(request.postDataJSON());
  });
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await expect(card.getByText("SIWC", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", {
      name: /Reauthorize SIWC|Unlink SIWC|Discover SIWC|Enable ChatGPT plan usage/,
    }),
  ).toHaveCount(0);
  await expect(
    card.getByText(
      /Other clients:|Codex clients:|SIWC expires|Plan permission/,
    ),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-account-id="account-2"]')
      .getByRole("button", { name: "Sign in with ChatGPT", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", { name: "Use SIWC", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(settings).toHaveLength(1);
  expect(settings[0]).toMatchObject({ settings: { use_siwc: true } });
  expect(credentials).toHaveLength(0);
  await expect(page.locator("[data-account-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(toggle).toBeChecked();
});

test("new accounts offer native authorization before card-based SIWC binding", async ({
  page,
}) => {
  await mockApi(page, configured([]));
  await mockCodex(page);
  await page.goto("/console/providers/codex");
  await page.getByRole("button", { name: "Add ChatGPT account" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Device code" })).toBeEnabled();
  await expect(
    dialog.getByRole("tab", { name: "Paste callback URL" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("tab", { name: "Sign in with ChatGPT" }),
  ).toHaveCount(0);
});

test("SIWC remains refreshable when native authorization needs renewal", async ({
  page,
}) => {
  const value = siwcAccount();
  value.status = "needs_reauthorization";
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await expect(card.getByText("SIWC", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .poll(() => controls.modelRefreshes.at(-1))
    .toEqual({ mode: "siwc" });
  expect(controls.starts).toHaveLength(0);
});

test("closing and reopening SIWC sign-in resumes the same grant and cancellation preserves native access", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("127.0.0.1 callback URL")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card
    .getByRole("button", { name: "Continue SIWC sign-in", exact: true })
    .click();
  await expect(dialog.getByLabel("127.0.0.1 callback URL")).toBeVisible();
  expect(controls.starts).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Cancel authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Authorization: cancelled", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Sign in with ChatGPT", exact: true }),
  ).toBeEnabled();
  await expect(card.getByRole("button", { name: /^Reset/ })).toBeEnabled();
  await expect(card.getByText("SIWC", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-account-id]")).toHaveCount(1);
});

test("a rejected SIWC callback keeps the card unbound and allows retrying the same grant", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  controls.failCallback = true;
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const callback = dialog.getByLabel("127.0.0.1 callback URL");
  await callback.fill(
    "http://127.0.0.1:1455/auth/callback?code=test&state=wrong&client_id=oaiapp_test",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Invalid callback state", { exact: true }),
  ).toBeVisible();
  await expect(callback).not.toBeEmpty();
  controls.failCallback = false;
  await callback.fill(
    "http://127.0.0.1:1455/auth/callback?code=test&state=e2e-state&client_id=oaiapp_test",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.getByText("SIWC", { exact: true })).toBeVisible();
  expect(controls.starts).toHaveLength(1);
  expect(controls.callbacks).toHaveLength(2);
});

test("retrying a failed card sign-in retains the target account", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  controls.failStart = true;
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Authorization temporarily unavailable", { exact: true }),
  ).toBeVisible();
  controls.failStart = false;
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByLabel("127.0.0.1 callback URL")).toBeVisible();
  expect(controls.starts).toHaveLength(2);
  for (const start of controls.starts) {
    expect(start).toMatchObject({
      flow: "siwc_bind",
      account_ref: value.account_ref,
    });
    expect(start.request_consent).toBeUndefined();
  }
});

test("a SIWC grant missing plan permission keeps one sign-in action and requests consent on click", async ({
  page,
}) => {
  const value = siwcAccount(undefined, false);
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await expect(card.getByText("SIWC", { exact: true })).toHaveCount(0);
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("127.0.0.1 callback URL"),
  ).toBeVisible();
  expect(controls.starts[0]).toMatchObject({
    flow: "siwc_bind",
    account_ref: value.account_ref,
    request_consent: true,
  });
});

test("SIWC model discovery failures stay separate from successful authorization and preserve both catalog errors", async ({
  page,
}) => {
  const value = account();
  value.models_error = "Native catalog unavailable";
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  controls.failModels = true;
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("127.0.0.1 callback URL")
    .fill(
      "http://127.0.0.1:1455/auth/callback?code=test&state=e2e-state&client_id=oaiapp_test",
    );
  const discovery = page.waitForResponse(
    (response) =>
      response.url().endsWith("/models") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await (await discovery).finished();
  await page.waitForLoadState("networkidle");
  await expect(card.getByText("SIWC", { exact: true })).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await dialog.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(
    dialog.getByText("Native catalog unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("SIWC: Public catalog unavailable", { exact: true }),
  ).toBeVisible();
});

test("a delayed response from a cancelled SIWC grant cannot replace a new sign-in", async ({
  page,
}) => {
  const value = account();
  await mockApi(page, configured([value]));
  const controls = await mockCodex(page, [value]);
  controls.holdCallback = true;
  await page.goto("/console/providers/codex");
  const card = page.locator('[data-account-id="account-1"]');
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const callback = dialog.getByLabel("127.0.0.1 callback URL");
  await callback.fill(
    "http://127.0.0.1:1455/auth/callback?code=old&state=e2e-state&client_id=oaiapp_test",
  );
  await dialog
    .getByRole("button", { name: "Complete authorization", exact: true })
    .click();
  await controls.callbackStarted.promise;
  await dialog
    .getByRole("button", { name: "Cancel authorization", exact: true })
    .click();
  await expect(
    dialog.getByText("Authorization: cancelled", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  await expect(callback).toBeVisible();
  const next =
    "http://127.0.0.1:1455/auth/callback?code=new&state=e2e-state&client_id=oaiapp_test";
  await callback.fill(next);
  const previous = page.waitForResponse(
    (response) =>
      response.url().endsWith("/callback") &&
      response.request().method() === "POST",
  );
  controls.callbackRelease.resolve();
  await (await previous).finished();
  await page.waitForLoadState("networkidle");
  await expect(
    dialog.getByText("Authorization: pending", { exact: true }),
  ).toBeVisible();
  await expect(callback).toHaveValue(next);
  expect(controls.starts).toHaveLength(2);
});
