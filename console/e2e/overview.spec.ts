import { expect, test, type Page } from "@playwright/test";
import { reportQuerySchema } from "../../src/reporting/query";
import {
  emptyAggregate,
  summarize,
  type SeriesRow,
} from "../../src/reporting/aggregates";
import {
  DAY_MS,
  HOUR_MS,
  previousRange,
  reportBucketMs,
  reportRange,
} from "../../src/reporting/ranges";
import type { Summary } from "../src/lib/api";
import { mockApi } from "./fixtures";

const now = Date.UTC(2026, 8, 12, 12, 30);
const start = Date.UTC(2026, 8, 12);
type SourceRow = SeriesRow & {
  provider_id: string;
  client_id: string;
  model: string;
};
function source(hour: number, alternate: boolean, previous = false): SourceRow {
  const requests = previous ? (alternate ? 3 : 4) : alternate ? 5 : 7;
  return {
    ...emptyAggregate(),
    hour,
    currency: alternate ? "EUR" : "USD",
    provider_id: alternate ? "archived-provider" : "example-provider",
    client_id: alternate ? "archived-client" : "example-client",
    model: alternate ? "other-model" : "example-model",
    requests_count: requests,
    success_count: previous ? requests : requests - 1,
    failed_count: !previous && !alternate ? 1 : 0,
    cancelled_count: !previous && alternate ? 1 : 0,
    missing_usage_count: !previous && !alternate ? 1 : 0,
    unpriced_count: !previous && !alternate ? 1 : 0,
    input_tokens: requests * 1000,
    uncached_input_tokens: requests * 200,
    cache_read_tokens: requests * 700,
    cache_write_tokens: requests * 100,
    output_tokens: requests * 100,
    reasoning_tokens: requests * 30,
    reasoning_samples: requests,
    first_response_sum: requests * 40,
    first_response_samples: requests,
    ttft_sum: requests * 80,
    ttft_samples: requests,
    first_text_sum: requests * 100,
    first_text_samples: requests,
    duration_sum: requests * 1000,
    duration_samples: requests,
    cost_nano: previous ? (alternate ? 1e9 : 2e9) : alternate ? 2e9 : 3.5e9,
  };
}
const samples = [
  source(start + 9 * HOUR_MS, false),
  source(start + 10 * HOUR_MS, true),
  source(start - DAY_MS + 9 * HOUR_MS, false, true),
  source(start - DAY_MS + 10 * HOUR_MS, true, true),
];

async function overviewApi(page: Page, sourceRows: SourceRow[] = samples) {
  await mockApi(page);
  const calls: URL[] = [];
  await page.route("**/console/api/report-options?**", async (route) =>
    route.fulfill({
      json: {
        providers: ["example-provider", "archived-provider"],
        models: ["example-model", "other-model"],
        clients: ["example-client", "archived-client"],
        time_zone: "UTC",
      },
    }),
  );
  await page.route("**/console/api/summary?**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const query = reportQuerySchema.parse(Object.fromEntries(url.searchParams));
    const range = reportRange(
      query.period,
      "UTC",
      now,
      query.from !== undefined && query.to !== undefined
        ? { from: query.from, to: query.to }
        : undefined,
    );
    const filter = (rows: SourceRow[]) =>
      rows.filter(
        (row) =>
          (!query.provider_id || row.provider_id === query.provider_id) &&
          (!query.client_id || row.client_id === query.client_id) &&
          (!query.model || row.model === query.model),
      );
    const rows = filter(
      sourceRows.filter((row) => row.hour >= range.from && row.hour < range.to),
    );
    const previous = previousRange(range);
    const previousRows = previous
      ? filter(
          sourceRows.filter(
            (row) => row.hour >= previous.from && row.hour < previous.to,
          ),
        )
      : [];
    const groups = new Map<string, SourceRow[]>();
    for (const row of rows) {
      const group = groups.get(row[query.group_by]) ?? [];
      group.push(row);
      groups.set(row[query.group_by], group);
    }
    const currency =
      query.cost_currency ??
      (rows.some((row) => row.currency === "USD")
        ? "USD"
        : (rows[0]?.currency ?? ""));
    const items = [...groups].map(([value, group]) => ({
      value,
      ...summarize(group),
    }));
    const score = (row: (typeof items)[number]) =>
      query.sort_by === "cost"
        ? (row.currencies[currency]?.cost_nano ?? 0)
        : query.sort_by === "tokens"
          ? row.totals.input_tokens + row.totals.output_tokens
          : row.totals.requests_count;
    items.sort((a, b) => score(b) - score(a));
    await route.fulfill({
      json: {
        range,
        ...summarize(rows),
        series: rows,
        bucket_ms: reportBucketMs(range),
        pending: 1,
        previous: previous
          ? {
              range: previous,
              ...summarize(previousRows),
              series: previousRows,
              bucket_ms: reportBucketMs(range),
            }
          : null,
        ranking: {
          dimension: query.group_by,
          metric: query.sort_by,
          currency,
          items,
          other: null,
        },
        retention: { days: 120, from: now - 120 * DAY_MS },
        partial_history: false,
        updated_at: now,
      } satisfies Summary,
    });
  });
  await page.route("**/console/api/requests?**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const query = reportQuerySchema.parse(Object.fromEntries(url.searchParams));
    await route.fulfill({
      json: {
        items: [],
        next_cursor: null,
        range: reportRange(
          query.period,
          "UTC",
          now,
          query.from !== undefined && query.to !== undefined
            ? { from: query.from, to: query.to }
            : undefined,
        ),
        retention: { days: 120, from: now - 120 * DAY_MS },
      },
    });
  });
  return calls;
}
const metric = (page: Page, name: string) =>
  page.locator('[data-slot="card"][aria-label="' + name + '"]');

test("overview shows outcomes, token composition, comparison and currency-isolated costs", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = await overviewApi(page);
  await page.goto("/console/overview");
  await expect(
    metric(page, "Requests").getByText("12", { exact: true }),
  ).toBeVisible();
  await expect(metric(page, "Success rate").getByText("83.33%")).toBeVisible();
  await expect(
    metric(page, "Known cost").getByText("$3.50", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("70.00%", { exact: true })).toBeVisible();
  const latency = page
    .getByText("Avg. first response", { exact: true })
    .locator("..");
  await expect(latency.getByText("40 ms", { exact: true })).toBeVisible();
  await expect(
    latency.getByText("12 reported samples", { exact: true }),
  ).toBeVisible();
  await expect(
    latency.getByText("Avg. first response", { exact: true }),
  ).toHaveAttribute(
    "title",
    /Avg\. first generation: 80 ms\. Avg\. first text: 100 ms/,
  );
  await expect(page.getByText("Of output: reasoning")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Choose color theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: testInfo.outputPath("overview-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Cost currency", exact: true })
    .click();
  await page.getByRole("option", { name: "EUR", exact: true }).click();
  await expect(
    metric(page, "Known cost").getByText("€2.00", { exact: true }),
  ).toBeVisible();
  await expect(
    metric(page, "Requests").getByText("12", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Trend metric" })
    .getByRole("button", { name: "Cost", exact: true })
    .click();
  await expect(page.getByText("Known cost EUR / 1h")).toBeVisible();
  await page
    .getByRole("group", { name: "Rank dimension" })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "other-model", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Rank by", exact: true }).click();
  await page.getByRole("option", { name: "By tokens", exact: true }).click();
  await expect
    .poll(() =>
      calls.some(
        (url) =>
          url.searchParams.get("group_by") === "model" &&
          url.searchParams.get("sort_by") === "tokens",
      ),
    )
    .toBe(true);
  await page.getByRole("tab", { name: "Last 7 days", exact: true }).click();
  await expect(
    metric(page, "Requests").getByText("19", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Cost currency", exact: true })
    .click();
  await page.getByRole("option", { name: "USD", exact: true }).click();
  await page.getByRole("combobox", { name: "Rank by", exact: true }).click();
  await page
    .getByRole("option", { name: "By known cost", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Filter by provider" }).click();
  await page
    .getByRole("option", { name: "archived-provider", exact: true })
    .click();
  await expect(
    metric(page, "Requests").getByText("8", { exact: true }),
  ).toBeVisible();
  await expect(
    metric(page, "Known cost").getByText("—", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No priced sources in this period" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("overview filters and failed-request links preserve the exact report window", async ({
  page,
}) => {
  const calls = await overviewApi(page);
  await page.goto("/console/overview");
  await page.getByRole("combobox", { name: "Filter by provider" }).click();
  await page
    .getByRole("option", { name: "example-provider", exact: true })
    .click();
  await expect(
    metric(page, "Requests").getByText("7", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by client" }).click();
  await page
    .getByRole("option", { name: "example-client", exact: true })
    .click();
  await expect(
    page.getByText("Updating filters…", { exact: false }),
  ).toBeHidden();
  await metric(page, "Success rate")
    .getByRole("link", { name: "1 failed", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Request log" }),
  ).toBeVisible();
  const query = new URL(page.url()).searchParams;
  expect(query.get("period")).toBe("custom");
  expect(query.get("from")).toBe(String(start));
  expect(query.get("to")).toBe(String(now));
  expect(query.get("provider_id")).toBe("example-provider");
  expect(query.get("client_id")).toBe("example-client");
  expect(query.get("outcome")).toBe("failed");
  expect(query.has("kind")).toBe(false);
  await expect
    .poll(() =>
      calls.some(
        (url) =>
          url.pathname.endsWith("/requests") &&
          url.searchParams.get("outcome") === "failed",
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "Custom", exact: true }),
  ).toHaveAttribute("data-state", "active");
});

test("trend tooltips use typed data and preserve the actual comparison dates", async ({
  page,
}) => {
  await overviewApi(page);
  await page.goto("/console/overview");
  const chart = page.getByLabel("Requests over time");
  await expect(chart).toBeVisible();
  const width = await chart.evaluate((element) => element.clientWidth);
  await chart.hover({ position: { x: 58 + (width - 68) * 0.75, y: 100 } });
  const tooltip = chart.locator(".recharts-tooltip-wrapper");
  await expect(
    tooltip.getByText("This period · 7", { exact: true }),
  ).toBeVisible();
  await expect(
    tooltip.getByText("Previous period · 4", { exact: true }),
  ).toBeVisible();
  await expect(tooltip).toContainText("Sep 12, 2026, 9:00:00 AM");
  await expect(tooltip).toContainText("Sep 11, 2026, 9:00:00 AM");
});

test("source rankings distinguish missing usage and pricing from zero shares", async ({
  page,
}) => {
  const missing = {
    ...source(start + 10 * HOUR_MS, true),
    ...emptyAggregate(),
    currency: "USD",
    requests_count: 5,
    success_count: 5,
    missing_usage_count: 5,
    unpriced_count: 5,
  };
  await overviewApi(page, [samples[0], missing]);
  await page.goto("/console/overview");
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "archived-provider", exact: true }),
  });
  for (const name of ["By tokens", "By known cost"]) {
    await page.getByRole("combobox", { name: "Rank by", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
    await expect(row.getByRole("cell").nth(1)).toHaveText("—");
    await expect(row.getByRole("cell").first()).toContainText("—");
    await expect(row.getByText("0.0%", { exact: true })).toHaveCount(0);
  }
});

test("time intervals drill down, and incomplete usage has its own request filter", async ({
  page,
}) => {
  await overviewApi(page);
  await page.goto("/console/overview?provider_id=example-provider");
  await page
    .getByRole("button", { name: /7 reported requests, 6 success/ })
    .click();
  await page.getByRole("link", { name: "View this interval" }).click();
  await expect(
    page.getByRole("heading", { name: "Request log" }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("from")).toBe(
    String(start + 9 * HOUR_MS),
  );
  expect(new URL(page.url()).searchParams.get("to")).toBe(
    String(start + 10 * HOUR_MS),
  );
  await page.goto("/console/overview");
  await page
    .getByRole("link", { name: "1 with incomplete usage", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Filter by data quality" }),
  ).toContainText("Missing / partial usage");
  expect(new URL(page.url()).searchParams.get("quality")).toBe("missing_usage");
});

test("custom ranges apply in the reporting time zone and mobile content fits", async ({
  page,
}, testInfo) => {
  const calls = await overviewApi(page);
  await page.goto("/console/overview");
  await page.getByRole("tab", { name: "Custom", exact: true }).click();
  await page.getByLabel("From · UTC").fill("2026-09-12T09:00");
  await page.getByLabel("To · UTC").fill("2026-09-12T10:00");
  await page.getByRole("button", { name: "Apply range" }).click();
  await expect(
    metric(page, "Requests").getByText("7", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("1h intervals · UTC", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("6h intervals · UTC", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Request outcomes", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("overview-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByText("1h intervals · UTC", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Total", exact: true }).click();
  await expect(
    page.getByText("Choose a period to see rates", { exact: true }),
  ).toBeVisible();
  const beforeInvalidRange = calls.length;
  await page.goto("/console/overview?period=custom&from=20&to=10");
  await expect(page.getByRole("alert")).toContainText(
    "The end must follow the start",
  );
  await expect(
    page.getByRole("button", { name: "Refresh report" }),
  ).toBeDisabled();
  expect(calls).toHaveLength(beforeInvalidRange);
});
