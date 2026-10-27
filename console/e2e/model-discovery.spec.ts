import { expect, test, type Page } from "@playwright/test";
import { providerSchema } from "../../src/config/schema";
import {
  accountViewSchema,
  type AccountView,
} from "../../src/providers/oauth/schema";
import { draftFixture, mockApi, type ConfigurationView } from "./fixtures";

const providers = ["codex", "antigravity", "claude", "xai"] as const;
type NativeProvider = (typeof providers)[number];

function account(provider: NativeProvider, model: string): AccountView {
  return accountViewSchema.parse({
    account_ref: crypto.randomUUID(),
    provider_id: provider,
    status: "ready",
    email: `${model}@example.test`,
    project_id: null,
    expires_at: Date.now() + 3_600_000,
    error: null,
    models: [
      {
        id: model,
        display_name: model,
        input_token_limit: null,
        output_token_limit: null,
      },
    ],
    models_updated_at: Date.now(),
    models_error: null,
    quota: {
      groups: [],
      subscription: null,
      updated_at: Date.now(),
      stale: false,
      last_error: null,
    },
  });
}

async function mockDiscovery(
  page: Page,
  provider: NativeProvider,
  ready = true,
) {
  const current = account(provider, "current-model");
  current.models_error = "Current account discovery failed";
  if (!ready) current.status = "needs_reauthorization";
  const removedReady = account(provider, "removed-ready-model");
  const removedFailed = account(provider, "removed-failed-model");
  removedFailed.status = "needs_reauthorization";
  removedFailed.models_error = "Removed account authorization expired";
  const accounts = [current, removedReady, removedFailed];
  const draft: ConfigurationView = draftFixture();
  draft.config.providers.push(
    providerSchema.parse({
      id: provider,
      type: provider,
      disabled: false,
      priority: 100,
      models: ["saved-model"],
      credentials: [
        {
          id: "current-credential",
          auth: { type: "oauth", account_ref: current.account_ref },
          disabled: false,
          priority: 100,
        },
      ],
    }),
  );
  await mockApi(page, draft);
  const refreshes: string[] = [];
  await page.route("**/console/api/provider-accounts**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/console/api/provider-accounts") {
      await route.fulfill({ json: { items: accounts } });
      return;
    }
    if (path.endsWith("/health")) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    const view = accounts.find(
      (account) => account.account_ref === path.split("/")[4],
    );
    if (!view) throw new Error(`Unexpected account request: ${path}`);
    if (request.method() === "POST" && path.endsWith("/models")) {
      refreshes.push(view.account_ref);
      view.models_error = null;
      view.models = [
        { ...view.models[0], id: "fresh-model", display_name: "fresh-model" },
      ];
    }
    await route.fulfill({ json: view });
  });
  await page.goto(`/console/providers/${provider}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(
    dialog.getByText("Current account discovery failed"),
  ).toBeVisible();
  return { dialog, current, refreshes };
}

for (const provider of providers) {
  test(`${provider} model discovery excludes removed accounts and their errors`, async ({
    page,
  }) => {
    const { dialog, current, refreshes } = await mockDiscovery(page, provider);
    await expect(
      dialog.getByRole("checkbox", { name: /saved-model/ }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: /current-model/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: /removed-/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText("Removed account authorization expired"),
    ).toHaveCount(0);

    await dialog.getByRole("button", { name: "Discover models" }).click();
    await expect(
      dialog.getByRole("checkbox", { name: /fresh-model/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Discover models" }),
    ).toBeEnabled();
    expect(refreshes).toEqual([current.account_ref]);
    await expect(
      dialog.getByText("Current account discovery failed"),
    ).toHaveCount(0);
    await expect(
      dialog.getByText("Removed account authorization expired"),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("checkbox", { name: /saved-model/ }),
    ).toBeChecked();

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /^Add .+ account$/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Add a previously authorized account" })
      .click();
    await expect(
      page.getByRole("option", { name: /removed-ready-model@example.test/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /removed-failed-model@example.test/ }),
    ).toBeVisible();
  });

  test(`${provider} model discovery requires a configured ready account`, async ({
    page,
  }) => {
    const { dialog, refreshes } = await mockDiscovery(page, provider, false);
    await expect(
      dialog.getByRole("button", { name: "Discover models" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("checkbox", { name: /current-model/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: /removed-/ }),
    ).toHaveCount(0);
    expect(refreshes).toEqual([]);
  });
}
