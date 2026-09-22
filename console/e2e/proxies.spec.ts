import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";

function fixture() {
  const draft = draftFixture();
  draft.config.proxy_groups = [
    {
      id: "US",
      strategy: "sticky",
      proxies: [
        {
          id: "us-1",
          url: "socks5://us.test:1080",
          username: "user",
          password: "saved-proxy-password",
          priority: 100,
          disabled: false,
        },
      ],
    },
  ];
  return draft;
}

test("group nodes retain their values after row removal and save without form metadata", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/proxies");
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Group ID").fill("US");
  await dialog.getByRole("combobox", { name: "Selection strategy" }).click();
  await page.getByRole("option", { name: "Priority", exact: true }).click();
  await dialog.getByRole("button", { name: "Add proxy", exact: true }).click();
  await dialog.getByLabel("Proxy ID", { exact: true }).fill("first");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://first.test:1080");
  await dialog.getByRole("button", { name: "Add proxy", exact: true }).click();
  await dialog.getByLabel("Proxy ID", { exact: true }).nth(1).fill("second");
  await dialog
    .getByLabel("SOCKS5 URL")
    .nth(1)
    .fill("socks5://second.test:1080");
  await dialog.getByLabel("Priority", { exact: true }).nth(1).fill("80");
  await dialog.getByLabel("Username", { exact: true }).nth(1).fill("user");
  await dialog
    .getByLabel("Password", { exact: true })
    .nth(1)
    .fill("proxy-password");
  await dialog
    .getByRole("button", { name: "Remove proxy 1", exact: true })
    .click();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://second.test:1080",
  );
  const saving = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith("/api/config"),
  );
  await dialog.getByRole("button", { name: "Save group", exact: true }).click();
  expect(JSON.stringify((await saving).postDataJSON())).not.toContain("rowId");
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0]).toMatchObject({
    id: "US",
    strategy: "priority",
    proxies: [{ id: "second", url: "socks5://second.test:1080", priority: 80 }],
  });
  await page.getByRole("button", { name: "Configure US", exact: true }).click();
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveAttribute(
    "placeholder",
    /Saved credential/,
  );
});

test("providers select groups and credentials retain explicit group, direct and inherited modes", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  await page.goto("/console/providers");
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Proxy group", exact: true })
    .click();
  await page.getByRole("option", { name: "US · sticky", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.providers[0].proxy_group).toBe("US");
  expect(
    mock.current().config.providers[0].credentials[0].proxy_group,
  ).toBeUndefined();
  for (const [label, reference] of [
    ["US · sticky", "US"],
    ["Direct connection", null],
    ["Use provider proxy group", undefined],
  ] as const) {
    await page.getByRole("button", { name: "Configure", exact: true }).click();
    await dialog.getByRole("tab", { name: "Credentials", exact: true }).click();
    await dialog
      .getByRole("combobox", { name: "Proxy group", exact: true })
      .click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await dialog
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(mock.current().config.providers[0].credentials[0].proxy_group).toBe(
      reference,
    );
  }
});

test("an in-flight group save keeps its editing snapshot open and prevents further edits", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  let markSaving = () => {};
  let releaseSave = () => {};
  const saving = new Promise<void>((resolve) => {
    markSaving = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      markSaving();
      await released;
    }
    await route.fallback();
  });
  await page.goto("/console/proxies");
  await page.getByRole("button", { name: "Configure US", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://saved.test:1080");
  await dialog.getByRole("button", { name: "Save group", exact: true }).click();
  await saving;
  try {
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByLabel("SOCKS5 URL")).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Add proxy", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseSave();
  }
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0].proxies[0].url).toBe(
    "socks5://saved.test:1080",
  );
  await page.getByRole("button", { name: "Configure US", exact: true }).click();
  await expect(dialog.getByLabel("SOCKS5 URL")).toBeEnabled();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://saved.test:1080",
  );
});

test("failed group edits and deletion remain visible and retryable; live health can be cleared", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  let failSave = true;
  let failures = 3;
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT" && failSave) {
      failSave = false;
      await route.fulfill({
        status: 409,
        json: { error: "Draft changed; retry this edit" },
      });
    } else await route.fallback();
  });
  await page.route("**/console/api/runtime/proxy-groups", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            group_id: "US",
            proxies: [
              {
                id: "us-1",
                status: failures ? "cooling" : "healthy",
                failures,
                cooling_until: failures ? Date.now() + 300_000 : null,
              },
            ],
            bindings: [
              {
                provider_id: "example-provider",
                proxy_id: "us-1",
                created_at: Date.now(),
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(
    "**/console/api/runtime/proxy-groups/US/proxies/us-1/health",
    async (route) => {
      expect(route.request().method()).toBe("DELETE");
      failures = 0;
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto("/console/proxies");
  await expect(page.getByText("Fixed bindings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear health", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Clear health", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Configure US", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://updated.test:1080");
  await dialog.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(
    dialog.getByText("Draft changed; retry this edit"),
  ).toBeVisible();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://updated.test:1080",
  );
  await dialog.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0].proxies[0].url).toBe(
    "socks5://updated.test:1080",
  );
  failSave = true;
  await page
    .getByRole("button", { name: "Delete group US", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(
    confirmation.getByText("Draft changed; retry this edit"),
  ).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  expect(mock.current().config.proxy_groups).toHaveLength(0);
});
