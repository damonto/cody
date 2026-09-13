import { test, expect } from "@playwright/test";
import type { UsageEvent } from "../src/lib/api";
import { previewSchema } from "../../src/admin/schema";
import { mockApi } from "./fixtures";

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
  await page.getByRole("combobox", { name: "Filter by service" }).click();
  await page.getByRole("option", { name: "example-provider" }).click();
  await expect
    .poll(() =>
      mock.calls.some((call) => call.includes("service_id=example-provider")),
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
    page.getByRole("link", { name: "Services", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Services", exact: true }).click();
  await expect(page).toHaveURL(/\/console\/services$/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Services", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(paths.every((path) => path.startsWith("/console/"))).toBe(true);
});

test("service forms preserve credentials, validate keys, and save before publishing", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/services");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Priority", { exact: true }).fill("250");
  await dialog.getByRole("tab", { name: "Upstream keys" }).click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Save service" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.services[0].priority).toBe(250);
  expect(mock.current().config.services[0].keys[0].api_key).toBe(
    "__CODY_SECRET_UNCHANGED__",
  );
  expect(
    mock.calls.filter((call) => call.includes("/console/api/config/publish")),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(() => mock.current().published_revision).toBe(2);
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await dialog.getByRole("button", { name: "Save service" }).click();
  await expect(dialog.getByLabel("Service ID")).toHaveAttribute(
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
    previewSchema.parse((await submitted).postDataJSON()).policy.pricing
      ?.tiers[1].input,
  ).toBe("8");
  await expect(dialog.getByText("$0.714", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save model policy" }).click();
  await expect
    .poll(
      () => mock.current().config.model_policies?.[0].pricing?.tiers[1].input,
    )
    .toBe("8");
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
});

test("request detail distinguishes missing counters and displays the original price version", async ({
  page,
}) => {
  await mockApi(page);
  const tokens = {
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
    schema_version: 1,
    sequence: 2,
    phase: "finished",
    request_id: "example-request-123",
    connection_id: null,
    response_id: "response-123",
    started_at: Date.now() - 1000,
    finished_at: Date.now(),
    client_id: "example-client",
    service_id: "example-provider",
    key_id: "primary",
    model: "example-model",
    requested_model: "alias",
    reported_model: "example-model",
    endpoint: "responses",
    method: "POST",
    protocol: "openai",
    transport: "sse",
    kind: "inference",
    outcome: "success",
    http_status: 200,
    diagnostic_code: null,
    duration_ms: 1000,
    ttft_ms: 100,
    first_text_ms: 250,
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
      input_nano: 360000000,
      output_nano: 120000000,
      cache_write_nano: 150000000,
      cache_read_nano: 84000000,
      total_nano: 714000000,
    },
    attempts: [],
  };
  await page.route("**/console/api/requests**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(event.request_id)
        ? event
        : { items: [event], next_cursor: null },
    }),
  );
  await page.goto("/console/requests");
  await expect(
    page.getByRole("cell", { name: "220K / 1M", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /example-requ/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("250 ms", { exact: true })).toBeVisible();
  await expect(
    dialog
      .getByText("Context size", { exact: true })
      .locator("..")
      .getByText("220K", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("1M", { exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "Pricing", exact: true }).click();
  await expect(
    dialog.getByText(event.billing.price_version!, { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
