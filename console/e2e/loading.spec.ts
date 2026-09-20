import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("reporting chunks load on navigation and are reused between report pages", async ({
  page,
}) => {
  const scripts: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") {
      scripts.push(new URL(request.url()).pathname);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  await page.goto("/console/providers/ai-gateway");
  await expect(
    page.getByRole("heading", { name: "AI Gateway", exact: true }),
  ).toBeVisible();
  const reportingScripts = () =>
    scripts.filter((path) =>
      /\/(?:overview|requests|report-filters)-/.test(path),
    );
  expect(reportingScripts()).toEqual([]);

  await page.getByRole("link", { name: "Model pricing", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Model pricing", exact: true }),
  ).toBeVisible();
  expect(reportingScripts()).toEqual([]);

  await page.getByRole("link", { name: "Requests", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Request log" }),
  ).toBeVisible();
  const sharedReports = () =>
    scripts.filter((path) => /\/report-filters-/.test(path));
  expect(sharedReports()).toHaveLength(1);
  expect(scripts.some((path) => /\/overview-/.test(path))).toBe(false);

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Usage overview" }),
  ).toBeVisible();
  expect(scripts.some((path) => /\/overview-/.test(path))).toBe(true);
  expect(sharedReports()).toHaveLength(1);
  expect(errors).toEqual([]);
});
