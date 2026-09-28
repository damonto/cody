import { expect, test, type Page } from "@playwright/test";
import type { Draft } from "../src/lib/api";
import { codexProviderSchema } from "../../src/config/schema";
import {
  accountViewSchema,
  type AccountHealth,
  type AccountView,
  type SessionView,
} from "../../src/providers/oauth/schema";
import { draftFixture, mockApi } from "./fixtures";

const hour = 3_600_000;

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

function configured(accounts: AccountView[]): Draft {
  const draft: Draft = draftFixture();
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
  };
  await page.route(
    (url) => url.pathname.startsWith("/console/api/oauth/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/sessions")) {
        const input: Record<string, unknown> = request.postDataJSON();
        controls.starts.push(input);
        const ref = crypto.randomUUID();
        const view = account(ref, false);
        accounts.set(ref, view);
        const device = input.flow === "device";
        const session: SessionView = {
          id: `${ref}.${crypto.randomUUID()}`,
          account_ref: ref,
          status: "pending",
          expires_at: Date.now() + 900_000,
          url: device
            ? "https://auth.openai.com/codex/device"
            : "https://auth.openai.com/oauth/authorize?state=e2e-state",
          flow: device ? "device" : "pkce",
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
  await expect(card.getByText(/^Exhausted · back in/)).toBeVisible();

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
  await expect(page.locator('[data-account-id^="account-"]')).toHaveCount(1);
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
