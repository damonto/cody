import { expect, test } from "@playwright/test";
import {
  newCodexProvider,
  newClaudeProvider,
} from "../../tests/helpers/native-provider-fixtures";
import { draftFixture, mockApi, type ConfigurationView } from "./fixtures";

for (const format of ["openai", "anthropic"] as const) {
  test(`${format}: native pricing saves the matching durations and previews them`, async ({
    page,
  }) => {
    const initial: ConfigurationView = draftFixture();
    const native =
      format === "openai" ? newCodexProvider() : newClaudeProvider();
    native.models = ["native-model"];
    initial.config.providers.push(native);
    const template = initial.config.model_prices![0].pricing!;
    initial.config.model_prices!.push({
      provider_id: native.id,
      model: "native-model",
      pricing: {
        ...template,
        tiers: [template.tiers[0], { ...template.tiers[1] }],
      },
    });
    const mock = await mockApi(page, initial);
    await page.goto(
      `/console/pricing?provider=${native.id}&model=native-model`,
    );
    const group = format === "openai" ? "OpenAI" : "Claude";
    const short = format === "openai" ? "30 minutes" : "5 minutes";
    const long = format === "openai" ? "12 hours" : "1 hour";
    await page
      .getByText(`Optional ${group} cache duration prices`, { exact: true })
      .first()
      .click();
    await page
      .getByLabel(`Cache write · ${short}`, { exact: true })
      .first()
      .fill("0");
    await page
      .getByLabel(`Cache write · ${long}`, { exact: true })
      .first()
      .fill("8");
    const other = format === "openai" ? "Claude" : "OpenAI";
    await expect(
      page.getByText(`Optional ${other} cache duration prices`, {
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Save model price", exact: true })
      .click();
    const field = format === "openai" ? "cache_write_30m" : "cache_write_5m";
    await expect
      .poll(
        () =>
          mock
            .current()
            .config.model_prices?.find(
              (price) => price.provider_id === native.id,
            )?.pricing?.tiers[0][field],
      )
      .toBe("0");
    await page.route("**/console/api/pricing/history?**", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "price-history",
              revision: mock.current().version,
              created_at: Date.now(),
              price: mock
                .current()
                .config.model_prices!.find(
                  (price) => price.provider_id === native.id,
                )!,
            },
          ],
        },
      }),
    );
    await page.getByRole("tab", { name: "Price history", exact: true }).click();
    await page
      .getByText(`Revision ${mock.current().version}`, { exact: false })
      .click();
    await expect(
      page.getByRole("columnheader", {
        name: `Cache write · ${short}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "0", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "Rates & context", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Test pricing", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByLabel(`Cache write · ${short}`, { exact: true }),
    ).toBeVisible();
    const requestPromise = page.waitForRequest((request) =>
      request.url().endsWith("/pricing/preview"),
    );
    await dialog
      .getByRole("button", { name: "Calculate cost", exact: true })
      .click();
    const payload = (await requestPromise).postDataJSON();
    expect(payload.usage[`${field}_tokens`]).toBe(20000);
    expect(
      payload.usage[
        format === "openai" ? "cache_write_5m_tokens" : "cache_write_30m_tokens"
      ],
    ).toBeNull();
  });
}

test("AI Gateway exposes both formats and clears inactive calculator counters", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/console/pricing");
  await expect(
    page
      .getByText("Optional OpenAI cache duration prices", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByText("Optional Claude cache duration prices", { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Test pricing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Cache duration format", { exact: true }).click();
  await page.getByRole("option", { name: "Claude", exact: true }).click();
  await expect(
    dialog.getByLabel("Cache write · 30 minutes", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Cache write · 5 minutes", { exact: true })
    .fill("20000");
  await dialog.getByLabel("Cache write · 1 hour", { exact: true }).fill("0");
  const pending = page.waitForRequest((request) =>
    request.url().endsWith("/pricing/preview"),
  );
  await dialog
    .getByRole("button", { name: "Calculate cost", exact: true })
    .click();
  const payload = (await pending).postDataJSON();
  expect(payload.usage.cache_write_30m_tokens).toBeNull();
  expect(payload.usage.cache_write_12h_tokens).toBeNull();
  expect(payload.usage.cache_write_5m_tokens).toBe(20000);
});

test("AI Gateway calculator selects configured Claude prices and leaves OpenAI counters unknown", async ({
  page,
}) => {
  const initial = draftFixture();
  for (const tier of initial.config.model_prices![0].pricing!.tiers) {
    tier.cache_write_5m = "5";
    tier.cache_write_1h = "10";
  }
  await mockApi(page, initial);
  await page.goto("/console/pricing");
  await page.getByRole("button", { name: "Test pricing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", {
      name: "Cache duration format",
      exact: true,
    }),
  ).toHaveText("Claude");
  await expect(
    dialog.getByLabel("Cache write · 5 minutes", { exact: true }),
  ).toHaveValue("20000");
  await expect(
    dialog.getByLabel("Cache write · 30 minutes", { exact: true }),
  ).toHaveCount(0);
  const pending = page.waitForRequest((request) =>
    request.url().endsWith("/pricing/preview"),
  );
  await dialog
    .getByRole("button", { name: "Calculate cost", exact: true })
    .click();
  const payload = (await pending).postDataJSON();
  expect(payload.usage.cache_write_5m_tokens).toBe(20000);
  expect(payload.usage.cache_write_30m_tokens).toBeNull();
  expect(payload.usage.cache_write_12h_tokens).toBeNull();
});

test("fresh pricing skips empty native providers and saves the first model price", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  initial.config.providers.unshift(newCodexProvider());
  initial.config.model_prices = [];
  const mock = await mockApi(page, initial);
  await page.goto("/console/pricing");
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toContainText("example-provider");
  await page
    .getByRole("button", { name: "Configure prices", exact: true })
    .click();
  for (const [label, value] of [
    ["Input", "2"],
    ["Output", "4"],
    ["Cache read", "0.5"],
    ["Cache write", "0"],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page
    .getByRole("button", { name: "Save model price", exact: true })
    .click();
  await expect
    .poll(
      () =>
        mock
          .current()
          .config.model_prices?.find(
            (price) => price.provider_id === "example-provider",
          )?.pricing?.tiers[0].input,
    )
    .toBe("2");
  await page.goto(
    "/console/pricing?provider=removed-provider&model=removed-model",
  );
  await expect(page.getByLabel("Input", { exact: true })).toHaveValue("2");
});

test("an explicitly selected provider without models keeps the provider switcher", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  const native = newCodexProvider();
  initial.config.providers.unshift(native);
  await mockApi(page, initial);
  await page.goto(`/console/pricing?provider=${native.id}`);
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toContainText("Codex");
  await expect(
    page.getByRole("link", { name: "Configure provider", exact: true }),
  ).toHaveAttribute("href", "/console/providers/codex");
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page
    .getByRole("option", { name: "example-provider", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save model price", exact: true }),
  ).toBeVisible();
});

test("an installation with no configured models provides a settings path", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  initial.config.providers = [newCodexProvider()];
  initial.config.model_prices = [];
  initial.config.api_keys = [];
  await mockApi(page, initial);
  await page.goto("/console/pricing");
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Configure provider", exact: true })
    .click();
  await expect(page).toHaveURL(/\/console\/providers\/codex$/);
});
