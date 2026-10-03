import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

for (const [type, add] of [
  ["antigravity", "Add Google account"],
  ["codex", "Add ChatGPT account"],
  ["claude", "Add Claude account"],
  ["xai", "Add xAI account"],
]) {
  test(`${type}: add the first account without saving settings`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.route("**/console/api/provider-accounts**", (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/console/api/") && request.method() !== "GET")
        writes.push(request.url());
    });
    await page.goto(`/console/providers/${type}`);
    await expect(
      page.getByText("Save provider settings before adding accounts."),
    ).toHaveCount(0);
    await page.getByRole("button", { name: add, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("missing provider reports initialization failure and can retry", async ({
  page,
}) => {
  await mockApi(page);
  let missing = true;
  await page.route("**/console/api/native-providers/codex", async (route) => {
    if (missing)
      await route.fulfill({
        json: { version: 1, item: null, etag: "missing" },
      });
    else await route.fallback();
  });
  await page.goto("/console/providers/codex");
  await expect(
    page.getByText(
      "Provider is not initialized. Apply database migrations and retry.",
    ),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Add ChatGPT account", exact: true }),
  ).toHaveCount(0);
  missing = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add ChatGPT account", exact: true }),
  ).toBeEnabled();
});
