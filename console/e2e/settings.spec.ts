import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";

test("reporting and search save independently without discarding another form's edits", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/settings");
  await expect(page.getByRole("button", { name: /Import|Export/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Archived configuration", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Request detail retention (days)").fill("90");
  await page.getByLabel("Search mode").click();
  await page.getByRole("option", { name: "Tavily" }).click();
  await page.getByLabel("Search API key", { exact: true }).fill("search-key");
  await page
    .getByRole("button", { name: "Save search settings", exact: true })
    .click();
  await expect.poll(() => mock.current().config.web_search.mode).toBe("tavily");
  expect(mock.current().config.reporting?.retention_days).toBe(120);
  await expect(page.getByLabel("Request detail retention (days)")).toHaveValue(
    "90",
  );
  await page
    .getByRole("button", { name: "Save reporting settings", exact: true })
    .click();
  await expect
    .poll(() => mock.current().config.reporting?.retention_days)
    .toBe(90);
  expect(mock.calls).toContain("PUT /console/api/settings/web-search");
  expect(mock.calls).toContain("PUT /console/api/settings/reporting");
  expect(mock.calls).not.toContain("PATCH /console/api/config");
  expect(mock.calls).not.toContain("GET /console/api/config/archived");
});

test("model settings save independently without discarding edited prices", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/pricing");
  await page.getByLabel("Input", { exact: true }).nth(1).fill("8");
  await page.getByLabel("Context window (tokens)").fill("200000");
  await page
    .getByRole("button", { name: "Save model settings", exact: true })
    .click();
  await expect
    .poll(
      () =>
        mock.current().config.providers[0].model_settings?.["example-model"]
          .context_window,
    )
    .toBe(200000);
  expect(mock.current().config.model_prices?.[0].pricing?.tiers[1].input).toBe(
    "6",
  );
  await expect(page.getByLabel("Input", { exact: true }).nth(1)).toHaveValue(
    "8",
  );
  await page
    .getByRole("button", { name: "Save model price", exact: true })
    .click();
  await expect
    .poll(() => mock.current().config.model_prices?.[0].pricing?.tiers[1].input)
    .toBe("8");
  expect(
    mock.calls.some((call) =>
      /^PUT \/console\/api\/providers\/[^/]+\/models\//.test(call),
    ),
  ).toBe(true);
  expect(
    mock.calls.some((call) =>
      call.startsWith("PUT /console/api/model-prices/"),
    ),
  ).toBe(true);
});

test("settings load their resources and invalidate only the changed setting", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/settings");
  await expect(page.getByLabel("Request detail retention (days)")).toHaveValue(
    "120",
  );
  expect(mock.calls).toContain("GET /console/api/settings/reporting");
  expect(mock.calls).toContain("GET /console/api/settings/web-search");
  for (const resource of [
    "providers",
    "clients",
    "proxy-groups",
    "model-prices",
    "model-routes",
  ])
    expect(mock.calls).not.toContain(`GET /console/api/${resource}`);
  const searchReads = mock.calls.filter(
    (call) => call === "GET /console/api/settings/web-search",
  ).length;
  const reportingReads = mock.calls.filter(
    (call) => call === "GET /console/api/settings/reporting",
  ).length;
  await page.getByLabel("Request detail retention (days)").fill("90");
  await page
    .getByRole("button", { name: "Save reporting settings", exact: true })
    .click();
  await expect
    .poll(
      () =>
        mock.calls.filter(
          (call) => call === "GET /console/api/settings/reporting",
        ).length,
    )
    .toBe(reportingReads + 1);
  expect(
    mock.calls.filter((call) => call === "GET /console/api/settings/web-search")
      .length,
  ).toBe(searchReads);
});

test("native pages read only their singleton and proxy choices", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/providers/codex");
  await expect(
    page.getByRole("heading", { name: "Codex", exact: true }),
  ).toBeVisible();
  expect(mock.calls).toContain("GET /console/api/native-providers/codex");
  expect(mock.calls).toContain("GET /console/api/proxy-groups");
  for (const resource of [
    "providers",
    "clients",
    "settings/web-search",
    "model-prices",
  ])
    expect(mock.calls).not.toContain(`GET /console/api/${resource}`);
});

test("an external settings change retains local input and requires an explicit reload", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/settings");
  const retention = page.getByLabel("Request detail retention (days)");
  await retention.fill("90");
  mock.current().config.reporting!.retention_days = 180;
  mock.current().version += 1;
  await page.getByRole("button", { name: "Reload configuration" }).click();
  await expect(retention).toHaveValue("90");
  const save = page.getByRole("button", {
    name: "Save reporting settings",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Reload saved values" }).click();
  await expect(retention).toHaveValue("180");
  await retention.fill("100");
  await save.click();
  await expect
    .poll(() => mock.current().config.reporting?.retention_days)
    .toBe(100);
});

test("failed background refreshes preserve inline edits and allow retry", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/settings");
  const retention = page.getByLabel("Request detail retention (days)");
  await retention.fill("90");
  const path = "**/console/api/settings/reporting";
  await page.route(path, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Reporting temporarily unavailable" },
    }),
  );
  await page.getByRole("button", { name: "Reload configuration" }).click();
  await expect(
    page.getByText("Reporting temporarily unavailable"),
  ).toBeVisible();
  await expect(retention).toHaveValue("90");
  await page.unroute(path);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Reporting temporarily unavailable")).toHaveCount(
    0,
  );
  await expect(retention).toHaveValue("90");
  await page
    .getByRole("button", { name: "Save reporting settings", exact: true })
    .click();
  await expect
    .poll(() => mock.current().config.reporting?.retention_days)
    .toBe(90);
});

test("external price and context changes do not adopt a new version for old form values", async ({
  page,
  context,
}) => {
  await page.clock.install();
  const mock = await mockApi(page);
  await page.goto("/console/pricing");
  await page.getByLabel("Input", { exact: true }).nth(1).fill("8");
  await page.getByLabel("Context window (tokens)").fill("200000");
  mock.current().config.model_prices![0].pricing!.tiers[1].input = "9";
  mock.current().config.providers[0].model_settings![
    "example-model"
  ].context_window = 500000;
  mock.current().version += 1;
  await page.clock.fastForward(31_000);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(
    page.getByRole("button", { name: "Save model price", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save model settings", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Input", { exact: true }).nth(1)).toHaveValue(
    "8",
  );
  await expect(page.getByLabel("Context window (tokens)")).toHaveValue(
    "200000",
  );
  expect(mock.calls.filter((call) => call.startsWith("PUT "))).toEqual([]);
});

test("a masked search key rotation invalidates the original editing baseline", async ({
  page,
}) => {
  const initial = draftFixture();
  initial.config.web_search = {
    mode: "tavily",
    base_url: "https://api.tavily.com",
    api_key: "original-key",
    max_results: 5,
    prefer_native: false,
  };
  const mock = await mockApi(page, initial);
  await page.goto("/console/settings");
  await page.getByLabel("Maximum search results").fill("8");
  mock.rotateSearchKey("external-rotation");
  await page.getByRole("button", { name: "Reload configuration" }).click();
  await expect(
    page.getByRole("button", { name: "Save search settings", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Maximum search results")).toHaveValue("8");
  await page.getByRole("button", { name: "Reload saved values" }).click();
  await expect(page.getByLabel("Maximum search results")).toHaveValue("5");
  await page
    .getByRole("button", { name: "Show Search API key", exact: true })
    .click();
  await expect(page.getByLabel("Search API key", { exact: true })).toHaveValue(
    "external-rotation",
  );
});
