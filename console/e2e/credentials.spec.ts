import { expect, test, type Page, type Route } from "@playwright/test";
import { draftSchema } from "../../src/admin/schema";
import { SECRET_PLACEHOLDER } from "../../src/shared/secrets";
import { draftFixture, mockApi } from "./fixtures";

async function openProvider(page: Page) {
  await page.goto("/console/providers");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Upstream credentials" }).click();
  return dialog;
}

test("saved provider credentials can be viewed without rotation and follow their IDs after removal", async ({
  page,
}) => {
  const initial = draftFixture();
  initial.config.providers[0].credentials.push({
    id: "backup",
    auth: { type: "api_key", api_key: SECRET_PLACEHOLDER },
    priority: 50,
    disabled: false,
  });
  const mock = await mockApi(page, initial);
  const dialog = await openProvider(page);
  const inputs = dialog.getByLabel("API key", { exact: true });
  await expect(inputs.first()).toHaveValue("");
  await expect(inputs.first()).toHaveAttribute("type", "password");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .first()
    .click();
  await expect(inputs.first()).toHaveValue(
    mock.providerKey("example-provider", "primary"),
  );
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .last()
    .click();
  await expect(inputs.last()).toHaveValue(
    mock.providerKey("example-provider", "backup"),
  );
  expect(mock.calls.some((call) => call.startsWith("PUT"))).toBe(false);

  await dialog
    .getByRole("button", { name: "Remove credential 1", exact: true })
    .click();
  await expect(inputs).toHaveCount(1);
  await expect(inputs).toHaveValue("");
  await expect(inputs).toHaveAttribute("type", "password");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(inputs).toHaveValue(
    mock.providerKey("example-provider", "backup"),
  );
  const saving = page.waitForRequest((request) => request.method() === "PUT");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  const submitted = draftSchema.parse((await saving).postDataJSON());
  expect(submitted.config.providers[0].credentials).toEqual([
    {
      id: "backup",
      auth: { type: "api_key", api_key: SECRET_PLACEHOLDER },
      priority: 50,
      disabled: false,
    },
  ]);
  await expect(dialog).toBeHidden();
  await openProvider(page);
  await expect(inputs).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(inputs).toHaveValue(
    mock.providerKey("example-provider", "backup"),
  );
});

test("provider key inputs show current manual values and newly added credentials", async ({
  page,
}) => {
  const mock = await mockApi(page);
  const dialog = await openProvider(page);
  const inputs = dialog.getByLabel("API key", { exact: true });
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(inputs).toHaveValue(
    mock.providerKey("example-provider", "primary"),
  );
  await inputs.fill("manual-upstream-key");
  await dialog
    .getByRole("button", { name: "Hide API key", exact: true })
    .click();
  await expect(inputs).toHaveAttribute("type", "password");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(inputs).toHaveValue("manual-upstream-key");
  await dialog
    .getByRole("button", { name: "Add credential", exact: true })
    .click();
  await expect(inputs).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "Show API key", exact: true }),
  ).toBeDisabled();
  await inputs.last().fill("new-upstream-key");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(inputs.last()).toHaveAttribute("type", "text");
  await expect(inputs.last()).toHaveValue("new-upstream-key");
  expect(mock.calls.filter((call) => call.includes("/reveal"))).toHaveLength(1);
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.providerKey("example-provider", "primary")).toBe(
    "manual-upstream-key",
  );
  const added = mock.current().config.providers[0].credentials[1];
  expect(mock.providerKey("example-provider", added.id)).toBe(
    "new-upstream-key",
  );
});

test("a newer draft clears revealed provider credentials while preserving unsaved edits", async ({
  page,
  context,
}) => {
  await page.clock.install();
  const mock = await mockApi(page);
  const dialog = await openProvider(page);
  const key = dialog.getByLabel("API key", { exact: true });
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(key).toHaveValue(
    mock.providerKey("example-provider", "primary"),
  );
  await dialog.getByLabel("Credential priority").fill("90");
  mock.current().version += 1;
  await page.clock.fastForward(31_000);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect
    .poll(
      () =>
        mock.calls.filter((call) => call === "GET /console/api/config").length,
    )
    .toBeGreaterThan(1);
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
  await expect(dialog.getByLabel("Credential priority")).toHaveValue("90");
  await dialog
    .getByRole("button", { name: "Show API key", exact: true })
    .click();
  await expect(
    page.getByText("The draft changed; reload before viewing this key"),
  ).toBeVisible();
  await expect(key).toHaveValue("");
});

test("credential rows keep identity while editing IDs and removing other rows", async ({
  page,
}) => {
  const mock = await mockApi(page);
  const dialog = await openProvider(page);
  await dialog
    .getByRole("button", { name: "Add credential", exact: true })
    .click();
  const id = dialog.getByLabel("Credential ID", { exact: true }).last();
  await id.fill("");
  await id.pressSequentially("replacement");
  await expect(id).toHaveValue("replacement");
  await expect(id).toBeFocused();
  await dialog
    .getByLabel("API key", { exact: true })
    .last()
    .fill("new-upstream-secret");
  await dialog.getByLabel("Credential priority").last().fill("73");
  await dialog
    .getByRole("button", { name: "Remove credential 1", exact: true })
    .click();
  await expect(id).toHaveValue("replacement");
  await expect(dialog.getByLabel("Credential priority")).toHaveValue("73");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.providers[0].credentials).toEqual([
    {
      id: "replacement",
      auth: { type: "api_key", api_key: SECRET_PLACEHOLDER },
      priority: 73,
      disabled: false,
    },
  ]);
  expect(mock.providerKey("example-provider", "replacement")).toBe(
    "new-upstream-secret",
  );
});

for (const mode of ["tavily", "exa"] as const) {
  test(`${mode} search credentials can be viewed, hidden, and saved without rotation`, async ({
    page,
  }) => {
    const initial = draftFixture();
    initial.config.web_search = {
      mode,
      api_key: `saved-${mode}-key`,
      base_url: "https://search.example",
      max_results: 5,
    };
    const mock = await mockApi(page, initial);
    await page.goto("/console/settings");
    const key = page.getByLabel("Search API key", { exact: true });
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("type", "password");
    await page
      .getByRole("button", { name: "Show Search API key", exact: true })
      .click();
    await expect(key).toHaveValue(mock.searchKey());
    await page
      .getByRole("button", { name: "Hide Search API key", exact: true })
      .click();
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("type", "password");
    await page
      .getByRole("button", { name: "Show Search API key", exact: true })
      .click();
    await expect(key).toHaveValue(mock.searchKey());
    const saving = page.waitForRequest((request) => request.method() === "PUT");
    await page.getByRole("button", { name: "Save settings" }).click();
    const submitted = draftSchema.parse((await saving).postDataJSON());
    expect(submitted.config.web_search).toMatchObject({
      mode,
      api_key: SECRET_PLACEHOLDER,
    });
    await expect(key).toHaveValue("");
    expect(mock.searchKey()).toBe(`saved-${mode}-key`);
    await page.reload();
    await expect(key).toHaveAttribute("type", "password");
    await page
      .getByRole("button", { name: "Show Search API key", exact: true })
      .click();
    await expect(key).toHaveValue(mock.searchKey());
  });
}

test("switching search providers cancels a pending reveal and shows only the new input", async ({
  page,
}) => {
  const initial = draftFixture();
  initial.config.web_search = {
    mode: "tavily",
    api_key: "old-search-key",
    base_url: "https://search.example",
    max_results: 5,
  };
  const mock = await mockApi(page, initial);
  const requests: Route[] = [];
  await page.route("**/console/api/config/web-search/reveal", (route) => {
    requests.push(route);
  });
  await page.goto("/console/settings");
  const key = page.getByLabel("Search API key", { exact: true });
  await page
    .getByRole("button", { name: "Show Search API key", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("combobox", { name: "Search mode" }).click();
  await page.getByRole("option", { name: "Exa", exact: true }).click();
  const pending = requests.shift();
  if (!pending) throw new Error("Expected a pending search key request");
  await pending.fulfill({ json: { api_key: "old-search-key" } });
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
  await expect(
    page.getByRole("button", { name: "Show Search API key", exact: true }),
  ).toBeDisabled();
  await key.fill("new-exa-key");
  await page
    .getByRole("button", { name: "Show Search API key", exact: true })
    .click();
  await expect(key).toHaveValue("new-exa-key");
  await expect(key).toHaveAttribute("type", "text");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(key).toHaveValue("");
  expect(mock.searchKey()).toBe("new-exa-key");
});
