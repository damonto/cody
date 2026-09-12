import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("a failed page chunk preserves navigation and recovers after reload", async ({
  page,
}) => {
  await mockApi(page);
  const chunk = "**/console/assets/overview-*.js";
  await page.route(chunk, (route) => route.abort("failed"));
  await page.goto("/console/overview");
  await expect(
    page.getByRole("heading", { name: "Could not open this page" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Services", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Services", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Could not open this page" }),
  ).toBeVisible();

  await page.unroute(chunk);
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect(
    page.getByRole("heading", { name: "Usage overview" }),
  ).toBeVisible();
});

test("a provider failure shows application recovery and reload restores the console", async ({
  page,
}) => {
  await mockApi(page);
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (sessionStorage.getItem("cody-e2e-recovered") !== "true") {
        throw new Error("Injected provider failure");
      }
      return matchMedia(query);
    };
  });
  await page.goto("/console/services");
  await expect(
    page.getByRole("heading", { name: "Cody Console could not start" }),
  ).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.setItem("cody-e2e-recovered", "true"),
  );
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect(
    page.getByRole("heading", { name: "Services", exact: true }),
  ).toBeVisible();
});
