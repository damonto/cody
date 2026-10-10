import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("session rows show their model and clear only that model", async ({
  page,
}) => {
  await mockApi(page);
  const sessionId = "same/session?test";
  let rows = ["model-a", "model/b ?", null].map((model) => ({
    session_id: sessionId,
    model,
    provider_id: "provider",
    credential_id: "account",
    created_at: Date.now(),
    updated_at: Date.now(),
    expires_at: Date.now() + 60_000,
  }));
  const deletes: URL[] = [];
  await page.route("**/console/api/runtime/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/clients"))
      return route.fulfill({
        json: { items: [{ id: "client", name: "Client" }] },
      });
    if (url.pathname.endsWith("/health"))
      return route.fulfill({
        json: { object: "list", scope: "inference", data: [] },
      });
    if (route.request().method() === "DELETE") {
      deletes.push(url);
      const before = rows.length;
      rows = url.searchParams.has("model")
        ? rows.filter((row) => row.model !== url.searchParams.get("model"))
        : [];
      return route.fulfill({ json: { deleted: before - rows.length } });
    }
    return route.fulfill({
      json: { object: "list", data: rows, next_cursor: null },
    });
  });
  await page.goto("/console/runtime");
  await page.getByRole("tab", { name: "Session bindings" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Model", exact: true }),
  ).toBeVisible();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("model/b ?", { exact: true }) });
  await row.getByRole("button", { name: "Clear binding" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.searchParams.get("model")).toBe("model/b ?");
  expect(deletes[0]?.searchParams.has("release_context_ownership")).toBe(false);
  await expect(page.getByText("model-a", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear binding" })).toHaveCount(
    2,
  );
});
