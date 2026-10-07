import { calculateCost } from "../../src/billing/calculate";
import { isConfigurationMutation } from "./fixtures";
import { test, expect } from "@playwright/test";
import type { UsageEvent } from "../src/lib/api";
import { previewSchema } from "../../src/admin/schema";
import { mockApi, draftFixture } from "./fixtures";
import { usage } from "../../tests/admin/fixtures.ts";

test("request details explain skipped retries and preserve unknown historical decisions", async ({
  page,
}) => {
  await mockApi(page);
  const event = usage("retry-failure", Date.now() - 5000);
  event.outcome = "failed";
  event.diagnostic_code = "rate_limit_exceeded";
  event.attempts[0].retry_diagnostic = {
    reason: "output_observed",
    event_type: "response.output_text.delta",
  };
  const historical = structuredClone(event);
  historical.request_id = "retry-historical";
  delete historical.attempts[0].retry_diagnostic;
  const items = [event, historical];
  await page.route("**/console/api/requests**", (route) =>
    route.fulfill({
      json: items.find((item) =>
        new URL(route.request().url()).pathname.endsWith(item.request_id),
      ) ?? { items, next_cursor: null },
    }),
  );
  await page.goto("/console/requests");
  await page.getByRole("button", { name: "retry-failur" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Routing & attempts" }).click();
  await expect(
    dialog.getByText("rate_limit_exceeded", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("columnheader", { name: "Retry decision" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Output detected; retry inspection stopped", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Event: response.output_text.delta", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "retry-histor" }).click();
  await dialog.getByRole("tab", { name: "Routing & attempts" }).click();
  await expect(
    dialog.getByRole("cell", { name: "Not recorded", exact: true }),
  ).toBeVisible();
});

test("report ranges, filters, empty states, and mobile navigation work", async ({
  page,
}) => {
  const errors: string[] = [];
  const paths: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => paths.push(new URL(request.url()).pathname));
  const mock = await mockApi(page);
  await page.goto("/console/");
  await expect(page).toHaveURL(/\/console\/overview$/);
  await expect(
    page.getByRole("heading", { name: "Usage overview" }),
  ).toBeVisible();
  for (const [title, period] of [
    ["Today", "day"],
    ["This week", "week"],
    ["This month", "month"],
    ["Total", "total"],
  ]) {
    await page.getByRole("tab", { name: title, exact: true }).click();
    await expect
      .poll(() =>
        mock.calls.some((call) =>
          call.includes(`/console/api/summary?period=${period}`),
        ),
      )
      .toBe(true);
  }
  await expect(page.getByText(/All time through/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your traffic will appear here" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by provider" }).click();
  await page.getByRole("option", { name: "example-provider" }).click();
  await expect
    .poll(() =>
      mock.calls.some((call) => call.includes("provider_id=example-provider")),
    )
    .toBe(true);
  await page.goto("/console/requests?period=total");
  await expect(
    page.getByRole("combobox", { name: "Filter by request kind" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Total", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect
    .poll(() =>
      mock.calls.some((call) =>
        call.includes("/console/api/requests?period=total"),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "Total", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Providers", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("link", { name: "AI Gateway", exact: true }).click();
  await expect(page).toHaveURL(/\/console\/providers\/ai-gateway$/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "AI Gateway", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(paths.every((path) => path.startsWith("/console/"))).toBe(true);
});

test("provider forms preserve credentials, validate credentials, and save before publishing", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/providers");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Priority", { exact: true }).fill("250");
  await dialog.getByRole("tab", { name: "Credentials" }).click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.providers[0].priority).toBe(250);
  expect(mock.current().config.providers[0].credentials[0].auth).toEqual({
    type: "api_key",
    api_key: "__CODY_SECRET_UNCHANGED__",
  });
  expect(
    mock.calls.filter((call) => call.includes("/console/api/config/publish")),
  ).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => mock.current().version).toBe(2);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(dialog.getByLabel("Provider name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("context tier pricing and the calculator use the edited policy", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/pricing");
  await page.getByLabel("Input", { exact: true }).nth(1).fill("8");
  await page.getByRole("button", { name: "Test pricing" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Total input", { exact: true }).fill("220000");
  const submitted = page.waitForRequest((request) =>
    request.url().includes("/console/api/pricing/preview"),
  );
  await dialog.getByRole("button", { name: "Calculate cost" }).click();
  expect(
    previewSchema.parse((await submitted).postDataJSON()).price.pricing
      ?.tiers[1].input,
  ).toBe("8");
  await expect(dialog.getByText("$0.714", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save model price" }).click();
  await expect
    .poll(() => mock.current().config.model_prices?.[0].pricing?.tiers[1].input)
    .toBe("8");
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
});

test("failed provider deletion stays open with an error and can be retried", async ({
  page,
}) => {
  const mock = await mockApi(page);
  let fail = true;
  await page.route("**/console/api/**", async (route) => {
    if (isConfigurationMutation(route.request()) && fail) {
      fail = false;
      await route.fulfill({
        status: 409,
        json: { error: "The draft changed; reload before saving" },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/console/providers");
  await page
    .getByRole("button", { name: "Delete example-provider", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Remove provider", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("The draft changed; reload before saving"),
  ).toBeVisible();
  expect(
    mock
      .current()
      .config.providers.filter((provider) => provider.type === "ai_gateway"),
  ).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Remove provider", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    mock
      .current()
      .config.providers.filter((provider) => provider.type === "ai_gateway"),
  ).toHaveLength(0);
  expect(
    mock
      .current()
      .config.providers.filter((provider) => provider.type !== "ai_gateway"),
  ).toHaveLength(4);
});

test("provider deletion detaches clients and refreshes cached routes", async ({
  page,
}) => {
  const initial = draftFixture();
  initial.config.model_routes = {
    "removed-alias": {
      model: "example-model",
      providers: ["example-provider"],
    },
  };
  initial.config.api_keys[0].model_routes = initial.config.model_routes;
  const mock = await mockApi(page, initial);
  await page.goto("/console/routing");
  await expect(page.getByText("removed-alias", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("link", { name: "AI Gateway", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete example-provider", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("automatically");
  await expect(dialog).toContainText("Affected clients: example-client");
  await dialog
    .getByRole("button", { name: "Remove provider", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.api_keys[0].providers).toEqual([]);
  expect(mock.current().config.model_routes).toEqual({});
  expect(mock.current().config.api_keys[0].model_routes).toBeUndefined();
  await page.getByRole("link", { name: "Client keys", exact: true }).click();
  await expect(
    page.getByText("No providers — no upstream access"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit client", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("checkbox", { checked: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save client", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("link", { name: "Model routes", exact: true }).click();
  await expect(page.getByText("removed-alias", { exact: true })).toHaveCount(0);
});

for (const protocol of ["openai", "anthropic"] as const) {
  test(`${protocol} tool-only requests show first response separately from text and price version`, async ({
    page,
  }) => {
    await mockApi(page);
    const tokens = {
      image_input_tokens: 0,
      image_output_tokens: 0,
      image_cache_read_tokens: 0,
      image_cache_write_tokens: 0,
      input_tokens: 220000,
      uncached_input_tokens: 60000,
      output_tokens: 4000,
      cache_read_tokens: 140000,
      cache_write_tokens: 20000,
      cache_write_5m_tokens: null,
      cache_write_1h_tokens: null,
      reasoning_tokens: null,
    };
    const event: UsageEvent = {
      schema_version: 2,
      sequence: 2,
      phase: "finished",
      request_id: "example-request-123",
      connection_id: null,
      response_id: "response-123",
      started_at: Date.now() - 125145,
      finished_at: Date.now(),
      client_id: "example-client",
      provider_id: "example-provider",
      credential_id: "primary",
      model: "example-model",
      upstream_model: "example-model",
      requested_model: "alias",
      reported_model: "example-model",
      upstream_observation: {
        request: { model: "example-model", reasoning: { effort: "xhigh" } },
        response: {
          model: "provider/example-model-2026-10-01",
          reasoning: { effort: "low" },
        },
      },
      endpoint: protocol === "openai" ? "responses" : "messages",
      method: "POST",
      protocol,
      transport: "sse",
      kind: "inference",
      outcome: "success",
      http_status: 200,
      diagnostic_code: null,
      duration_ms: 125145,
      first_response_ms: 2200,
      ttft_ms: 7679,
      first_text_ms: null,
      context_tokens: 220000,
      context_window: 1000000,
      context_source: "reported_input",
      config_revision: 1,
      observation_issue: null,
      usage: { tokens, status: "reported", raw: {} },
      billing: {
        status: "complete",
        currency: "USD",
        price_version: '[1,"example-provider","example-model"]',
        tier_index: 1,
        context_tokens: 220000,
        image_input_nano: 0,
        image_output_nano: 0,
        image_cache_read_nano: 0,
        image_cache_write_nano: 0,
        input_nano: 360000000,
        output_nano: 120000000,
        cache_write_nano: 150000000,
        cache_read_nano: 84000000,
        total_nano: 714000000,
      },
      attempts: [],
    };
    const missingLatency: UsageEvent = {
      ...event,
      request_id: "missing-latency-123",
      ttft_ms: 100,
      first_text_ms: 250,
    };
    delete missingLatency.first_response_ms;
    delete missingLatency.upstream_model;
    delete missingLatency.upstream_observation;
    const matching: UsageEvent = {
      ...event,
      request_id: "matching-observation",
      reported_model: "provider/example-model",
      upstream_observation: {
        request: { model: "example-model", reasoning: { effort: "high" } },
        response: {
          model: "provider/example-model",
          reasoning: { effort: "high" },
        },
      },
    };
    const unreported: UsageEvent = {
      ...event,
      request_id: "unreported-observation",
      reported_model: "",
      upstream_observation: {
        request: { model: "example-model", reasoning: { effort: "high" } },
        response: {},
      },
    };
    const unspecified: UsageEvent = {
      ...event,
      request_id: "unspecified-observation",
      upstream_observation: {
        request: { model: "example-model" },
        response: {
          model: "provider/example-model",
          reasoning: { effort: "xhigh" },
        },
      },
    };
    const views = [event, missingLatency, matching, unreported, unspecified];
    await page.route("**/console/api/requests**", (route) =>
      route.fulfill({
        json: views.find((item) =>
          new URL(route.request().url()).pathname.endsWith(item.request_id),
        ) ?? { items: views, next_cursor: null },
      }),
    );
    await page.goto("/console/requests");
    const warning = page.getByRole("button", {
      name: "Upstream response differs",
      exact: true,
    });
    await expect(warning).toHaveCount(1);
    await expect(page.getByText("Model mismatch", { exact: true })).toHaveCount(
      0,
    );
    await warning.hover();
    const tooltip = page.getByRole("tooltip");
    for (const value of [
      "Model mismatch",
      "Reasoning effort mismatch",
      "example-model",
      "provider/example-model-2026-10-01",
      "xhigh",
      "low",
    ])
      await expect(tooltip.getByText(value, { exact: true })).toBeVisible();
    await page.mouse.move(0, 0, { steps: 10 });
    await expect(tooltip).toBeHidden();
    await expect(
      page.getByRole("columnheader", { name: "First response", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "2.20 s", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "220K / 1M", exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /example-requ/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Image input (including cached images)", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("First response", { exact: true })
        .locator("..")
        .getByText("2.20 s", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("First generation event", { exact: true })
        .locator("..")
        .getByText("7.68 s", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("First text", { exact: true })
        .locator("..")
        .getByText("—", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("Context size", { exact: true })
        .locator("..")
        .getByText("220K", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("1M", { exact: true })).toBeVisible();
    await dialog
      .getByRole("tab", { name: "Routing & attempts", exact: true })
      .click();
    for (const [title, value] of [
      ["Requested model", "alias"],
      ["Routed model", "example-model"],
      ["Reasoning Effort", "Xhigh"],
    ])
      await expect(
        dialog
          .getByText(title, { exact: true })
          .locator("..")
          .getByText(value, { exact: true }),
      ).toBeVisible();
    for (const title of [
      "Reported Model",
      "Upstream request model",
      "Upstream response model",
      "Upstream request reasoning",
      "Upstream response reasoning",
      "Model comparison",
      "Reasoning comparison",
    ])
      await expect(dialog.getByText(title, { exact: true })).toHaveCount(0);
    const modelWarning = dialog
      .getByText("Routed model", { exact: true })
      .locator("..")
      .getByRole("button", { name: "Model mismatch", exact: true });
    await modelWarning.focus();
    await expect(
      tooltip.getByText("provider/example-model-2026-10-01", { exact: true }),
    ).toBeVisible();
    await expect(
      tooltip.getByText("Reasoning effort mismatch", { exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Refresh", exact: true }).focus();
    await expect(tooltip).toBeHidden();
    const effortWarning = dialog
      .getByText("Reasoning Effort", { exact: true })
      .locator("..")
      .getByRole("button", { name: "Reasoning effort mismatch", exact: true });
    await effortWarning.hover();
    await expect(tooltip.getByText("low", { exact: true })).toBeVisible();
    await expect(tooltip.getByText("xhigh", { exact: true })).toBeVisible();
    await expect(
      tooltip.getByText("Model mismatch", { exact: true }),
    ).toHaveCount(0);
    await page.mouse.move(0, 0, { steps: 10 });
    await expect(tooltip).toBeHidden();
    await dialog.getByRole("tab", { name: "Pricing", exact: true }).click();
    await expect(
      dialog.getByText(event.billing.price_version!, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: /missing-late/ }).click();
    await expect(
      dialog
        .getByText("First response", { exact: true })
        .locator("..")
        .getByText("—", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("First text", { exact: true })
        .locator("..")
        .getByText("250 ms", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("tab", { name: "Routing & attempts", exact: true })
      .click();
    await expect(
      dialog.getByText("Thinking level", { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog
        .getByText("Routed model", { exact: true })
        .locator("..")
        .getByText("example-model", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByText("Reasoning Effort", { exact: true })
        .locator("..")
        .getByText("Not recorded", { exact: true }),
    ).toBeVisible();
    for (const [id, effort] of [
      ["matching-obs", "High"],
      ["unreported-o", "High"],
      ["unspecified-", "Not specified"],
    ]) {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: new RegExp(id) }).click();
      await dialog
        .getByRole("tab", { name: "Routing & attempts", exact: true })
        .click();
      await expect(
        dialog
          .getByText("Reasoning Effort", { exact: true })
          .locator("..")
          .getByText(effort, { exact: true }),
      ).toBeVisible();
      await expect(
        dialog
          .getByText("Routed model", { exact: true })
          .locator("..")
          .getByText("example-model", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", {
          name: /mismatch/,
        }),
      ).toHaveCount(0);
    }
  });
}

test("image prices save, clear and drive separate calculator charges", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.route("**/console/api/pricing/preview", async (route) => {
    const input = previewSchema.parse(route.request().postDataJSON());
    await route.fulfill({ json: calculateCost(input.usage, input.price) });
  });
  await page.goto("/console/pricing");
  await page
    .getByText("Optional image token prices", { exact: true })
    .first()
    .click();
  for (const [label, value] of [
    ["Input", "2"],
    ["Output", "4"],
    ["Cache read", "1"],
    ["Cache write", "5"],
    ["Image input", "8"],
    ["Image output", "32"],
    ["Image cache read", "3"],
    ["Image cache write", "10"],
  ]) {
    await page.getByLabel(label, { exact: true }).first().fill(value);
  }
  await page.getByRole("button", { name: "Save model price" }).click();
  await expect
    .poll(
      () =>
        mock.current().config.model_prices?.[0].pricing?.tiers[0].image_input,
    )
    .toBe("8");
  await page.getByRole("button", { name: "Test pricing" }).click();
  const dialog = page.getByRole("dialog");
  for (const [label, value] of [
    ["Total input", "100"],
    ["Output (including reasoning)", "50"],
    ["Cache read", "30"],
    ["Cache write", "20"],
    ["Cache write · 5 minutes", "20"],
    ["Cache write · 1 hour", "0"],
    ["Reasoning", "0"],
    ["Image input (including cached images)", "80"],
    ["Image output", "30"],
    ["Image cache read", "20"],
    ["Image cache write", "15"],
  ]) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole("button", { name: "Calculate cost" }).click();
  await expect(dialog.getByText("$0.001655", { exact: true })).toBeVisible();
  await expect(dialog.getByText("$0.00036", { exact: true })).toBeVisible();
  await dialog.getByLabel("Image cache write", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "Calculate cost" }).click();
  await expect(dialog.getByText("partial", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Image cache write", { exact: true }).first().fill("");
  await page.getByLabel("Image input", { exact: true }).first().fill("");
  await page.getByLabel("Image output", { exact: true }).first().fill("0");
  await page.getByRole("button", { name: "Save model price" }).click();
  await expect
    .poll(
      () =>
        mock.current().config.model_prices?.[0].pricing?.tiers[0].image_input,
    )
    .toBeUndefined();
  await expect
    .poll(
      () =>
        mock.current().config.model_prices?.[0].pricing?.tiers[0].image_output,
    )
    .toBe("0");
  await expect
    .poll(
      () =>
        mock.current().config.model_prices?.[0].pricing?.tiers[0]
          .image_cache_write,
    )
    .toBeUndefined();
});
