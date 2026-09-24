import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import { SECRET_PLACEHOLDER } from "../../src/shared/secrets";

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

function twoNodeFixture() {
  const draft = fixture();
  draft.config.proxy_groups[0].proxies.push({
    id: "us-2",
    url: "socks5://second.test:1080",
    priority: 50,
    disabled: false,
  });
  return draft;
}

test("a standalone node dialog appends to the selected group and preserves its settings and other groups", async ({
  page,
}) => {
  const draft = fixture();
  draft.config.proxy_groups[0].proxies[0].password = SECRET_PLACEHOLDER;
  draft.config.proxy_groups.push({
    id: "UK",
    strategy: "priority",
    proxies: [],
  });
  const mock = await mockApi(page, draft);
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Add proxy to UK", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Add proxy to UK");
  await expect(dialog.getByLabel("Group ID")).toHaveCount(0);
  await expect(dialog.getByLabel("Selection strategy")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mock.current().version).toBe(1);
  await page
    .getByRole("button", { name: "Add proxy to UK", exact: true })
    .click();
  await dialog.getByLabel("Proxy ID", { exact: true }).fill("uk-new");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://new.test:1080");
  await dialog.getByLabel("Priority", { exact: true }).fill("75");
  await dialog.getByLabel("Username", { exact: true }).fill("user");
  await dialog.getByLabel("Password", { exact: true }).fill("new-password");
  const saving = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith("/api/config"),
  );
  await dialog.getByRole("button", { name: "Add proxy", exact: true }).click();
  const body = (await saving).postDataJSON();
  expect(JSON.stringify(body)).not.toContain("rowId");
  expect(body.config.proxy_groups[0]).toEqual(draft.config.proxy_groups[0]);
  expect(body.config.proxy_groups[1]).toEqual({
    id: "UK",
    strategy: "priority",
    proxies: [
      {
        id: "uk-new",
        url: "socks5://new.test:1080",
        priority: 75,
        disabled: false,
        username: "user",
        password: "new-password",
      },
    ],
  });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("row").filter({ hasText: "uk-new" }),
  ).toBeVisible();
  expect(mock.current().published_revision).toBe(1);
});

test("adding a node validates duplicate IDs and paired credentials and retains failed input for retry", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  let attempts = 0;
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Could not save the draft; retry" },
        });
        return;
      }
    }
    await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Add proxy to US", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const add = dialog.getByRole("button", { name: "Add proxy", exact: true });
  await dialog.getByLabel("Proxy ID", { exact: true }).fill("us-1");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://new.test:1080");
  await add.click();
  await expect(
    dialog.getByText("A proxy with this ID already exists in this group"),
  ).toBeVisible();
  expect(attempts).toBe(0);
  await dialog.getByLabel("Proxy ID", { exact: true }).fill("us-new");
  await dialog.getByLabel("Username", { exact: true }).fill("user");
  await add.click();
  await expect(
    dialog.getByText("username and password must be supplied together", {
      exact: false,
    }),
  ).toBeVisible();
  expect(attempts).toBe(0);
  await dialog.getByLabel("Password", { exact: true }).fill("new-password");
  await add.click();
  await expect(
    dialog.getByText("Could not save the draft; retry"),
  ).toBeVisible();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://new.test:1080",
  );
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue(
    "new-password",
  );
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(1);
  await add.click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(2);
  expect(attempts).toBe(2);
});

test("adding a node keeps a stale draft open without overwriting concurrent edits", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON().version).toBe(1);
      await route.fulfill({
        status: 409,
        json: { error: "The draft changed; reload before saving" },
      });
    } else await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Add proxy to US", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://new.test:1080");
  mock.current().version += 1;
  mock.current().config.proxy_groups[0].strategy = "priority";
  await dialog.getByRole("button", { name: "Add proxy", exact: true }).click();
  await expect(
    dialog.getByText("Refresh this page", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://new.test:1080",
  );
  expect(mock.current().config.proxy_groups[0]).toMatchObject({
    strategy: "priority",
    proxies: [{ id: "us-1" }],
  });
});

test("the row editor preserves saved credentials and locks its snapshot while saving", async ({
  page,
}) => {
  const draft = twoNodeFixture();
  draft.config.proxy_groups[0].proxies[0].password = SECRET_PLACEHOLDER;
  const mock = await mockApi(page, draft);
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT") await waiting;
    await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Edit proxy us-1 in US", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Edit proxy us-1");
  await expect(dialog.getByLabel("Proxy ID", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveAttribute(
    "placeholder",
    /Saved credential/,
  );
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://edited.test:1080");
  await dialog.getByLabel("Priority", { exact: true }).fill("65");
  const requested = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith("/api/config"),
  );
  await dialog.getByRole("button", { name: "Save proxy", exact: true }).click();
  const body = (await requested).postDataJSON();
  expect(body.config.proxy_groups[0].proxies[0].password).toBe(
    SECRET_PLACEHOLDER,
  );
  expect(JSON.stringify(body)).not.toContain("rowId");
  await expect(dialog.getByLabel("SOCKS5 URL")).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0]).toEqual({
    ...draft.config.proxy_groups[0],
    proxies: [
      {
        ...draft.config.proxy_groups[0].proxies[0],
        url: "socks5://edited.test:1080",
        priority: 65,
      },
      draft.config.proxy_groups[0].proxies[1],
    ],
  });
});

test("failed row edits remain visible and can be retried", async ({ page }) => {
  const mock = await mockApi(page, fixture());
  let fail = true;
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT" && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Could not save this edit" },
      });
    } else await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Edit proxy us-1 in US", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("SOCKS5 URL").fill("socks5://edited.test:1080");
  const save = dialog.getByRole("button", { name: "Save proxy", exact: true });
  await save.click();
  await expect(dialog.getByText("Could not save this edit")).toBeVisible();
  await expect(dialog.getByLabel("SOCKS5 URL")).toHaveValue(
    "socks5://edited.test:1080",
  );
  expect(mock.current().config.proxy_groups[0].proxies[0].url).toBe(
    "socks5://us.test:1080",
  );
  await save.click();
  await expect(dialog).toBeHidden();
  expect(mock.current().config.proxy_groups[0].proxies[0].url).toBe(
    "socks5://edited.test:1080",
  );
});

test("Test results preserve keyboard focus in other proxy rows", async ({
  page,
}) => {
  await mockApi(page, twoNodeFixture());
  let release = () => {};
  await page.route(
    "**/console/api/config/proxy-groups/US/proxies/us-1/test",
    async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: { ip: "203.0.113.9", country: "US" } });
    },
  );
  await page.goto("/console/proxies");
  const row = page
    .getByRole("row")
    .filter({ hasText: "socks5://us.test:1080" });
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Testing…");
  const editOther = page.getByRole("button", {
    name: "Edit proxy us-2 in US",
    exact: true,
  });
  await editOther.focus();
  release();
  await expect(row.getByText("203.0.113.9", { exact: true })).toBeVisible();
  await expect(editOther).toBeFocused();
});

for (const width of [1280, 800]) {
  test(`proxy column widths stay stable throughout Test states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockApi(page, twoNodeFixture());
    const replies = [
      { ip: "203.0.113.9", country: "US" },
      { ip: "2001:db8:1234:5678:90ab:cdef:1234:5678", country: "JP" },
      {
        error:
          "The proxy could not authenticate or establish a secure connection to IPinfo. Please check the proxy configuration before trying again.",
      },
    ] as const;
    let attempt = 0;
    let release = () => {};
    await page.route(
      "**/console/api/config/proxy-groups/US/proxies/us-1/test",
      async (route) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const reply = replies[attempt++];
        await route.fulfill({
          status: "error" in reply ? 502 : 200,
          json: reply,
        });
      },
    );
    await page.goto("/console/proxies");
    const table = page.getByRole("table").first();
    await expect(table).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const geometry = () =>
      table.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [
          bounds.width,
          ...Array.from(element.querySelectorAll("th"), (cell) => {
            const rect = cell.getBoundingClientRect();
            return [rect.x - bounds.x, rect.width];
          }).flat(),
        ];
      });
    const initial = await geometry();
    const stable = async () => {
      const current = await geometry();
      current.forEach((value, index) =>
        expect(Math.abs(value - initial[index])).toBeLessThan(1),
      );
    };
    const row = page
      .getByRole("row")
      .filter({ hasText: "socks5://us.test:1080" });
    for (const reply of replies) {
      const request = page.waitForRequest((entry) =>
        entry.url().endsWith("/us-1/test"),
      );
      await row.getByRole("button", { name: "Test", exact: true }).click();
      await request;
      await expect(row.getByRole("status")).toHaveText("Testing…");
      await stable();
      release();
      if ("error" in reply)
        await expect(row.getByRole("alert")).toHaveText(reply.error);
      else await expect(row.getByText(reply.ip, { exact: true })).toBeVisible();
      await stable();
    }
  });
}

test("list deletion can be cancelled, removes only its node and retains the final empty group", async ({
  page,
}) => {
  const mock = await mockApi(page, twoNodeFixture());
  await page.goto("/console/proxies");
  const first = page.getByRole("button", {
    name: "Delete proxy us-1 from US",
    exact: true,
  });
  const confirmation = page.getByRole("alertdialog");
  await first.click();
  await expect(confirmation).toContainText("Remove proxy us-1?");
  await expect(confirmation).toContainText("group US");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(2);
  await first.click();
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  expect(
    mock.current().config.proxy_groups[0].proxies.map((node) => node.id),
  ).toEqual(["us-2"]);
  await expect(first).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delete proxy us-2 from US", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  expect(mock.current().config.proxy_groups).toEqual([
    { id: "US", strategy: "sticky", proxies: [] },
  ]);
  expect(mock.current().published_revision).toBe(1);
  await expect(
    page.getByText("This group has no nodes.", { exact: false }),
  ).toBeVisible();
});

test("failed node deletion stays visible and can be retried", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  let fail = true;
  await page.route("**/console/api/config", async (route) => {
    if (route.request().method() === "PUT" && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Save unavailable; retry" },
      });
    } else await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Delete proxy us-1 from US", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  const remove = confirmation.getByRole("button", {
    name: "Remove from draft",
    exact: true,
  });
  await remove.click();
  await expect(confirmation.getByText("Save unavailable; retry")).toBeVisible();
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(1);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(confirmation).toBeHidden();
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(0);
});

test("node deletion preserves concurrent draft changes until the page is refreshed", async ({
  page,
}) => {
  const mock = await mockApi(page, fixture());
  await page.route("**/console/api/config", async (route) => {
    if (
      route.request().method() === "PUT" &&
      route.request().postDataJSON().version !== mock.current().version
    ) {
      await route.fulfill({
        status: 409,
        json: { error: "The draft changed; reload before saving" },
      });
    } else await route.fallback();
  });
  await page.goto("/console/proxies");
  await page
    .getByRole("button", { name: "Delete proxy us-1 from US", exact: true })
    .click();
  mock.current().version += 1;
  mock.current().config.proxy_groups[0].strategy = "priority";
  const confirmation = page.getByRole("alertdialog");
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(
    confirmation.getByText("Refresh this page", { exact: false }),
  ).toBeVisible();
  expect(mock.current().config.proxy_groups[0].proxies).toHaveLength(1);
  await page.reload();
  await page
    .getByRole("button", { name: "Delete proxy us-1 from US", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Remove from draft", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  expect(mock.current().config.proxy_groups[0]).toMatchObject({
    strategy: "priority",
    proxies: [],
  });
});

test("node tests run independently for disabled, cooling and unpublished nodes and clear on reload", async ({
  page,
}) => {
  const draft = twoNodeFixture();
  draft.config.proxy_groups[0].proxies[0].disabled = true;
  await mockApi(page, draft);
  await page.route("**/console/api/runtime/proxy-groups", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            group_id: "US",
            proxies: [
              {
                id: "us-1",
                status: "cooling",
                failures: 3,
                cooling_until: Date.now() + 300_000,
              },
            ],
            bindings: [],
          },
        ],
      },
    }),
  );
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/console/api/config/proxy-groups/US/proxies/*/test",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ version: 1 });
      expect(route.request().headers()["x-cody-admin"]).toBe("1");
      if (route.request().url().includes("/us-1/")) {
        await waiting;
        await route.fulfill({ json: { ip: "203.0.113.1", country: "US" } });
      } else
        await route.fulfill({ json: { ip: "2001:db8::2", country: "JP" } });
    },
  );
  await page.goto("/console/proxies");
  const first = page
    .getByRole("row")
    .filter({ hasText: "socks5://us.test:1080" });
  const second = page
    .getByRole("row")
    .filter({ hasText: "socks5://second.test:1080" });
  await first.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    first.getByRole("button", { name: "Test", exact: true }),
  ).toBeDisabled();
  await expect(
    first.getByRole("button", { name: "Delete proxy us-1 from US" }),
  ).toBeEnabled();
  await expect(first.getByRole("status")).toHaveText("Testing…");
  await second.getByRole("button", { name: "Test", exact: true }).click();
  await expect(second.getByText("2001:db8::2", { exact: true })).toBeVisible();
  await expect(second.getByRole("img", { name: "JP", exact: true })).toHaveText(
    "🇯🇵",
  );
  release();
  await expect(first.getByText("203.0.113.1", { exact: true })).toBeVisible();
  await expect(first.getByRole("img", { name: "US", exact: true })).toHaveText(
    "🇺🇸",
  );
  await expect(first.getByText("3 failures", { exact: true })).toBeVisible();
  await page.reload();
  await expect(first.getByText("—", { exact: true })).toBeVisible();
  await expect(second.getByText("—", { exact: true })).toBeVisible();
  await expect(page.getByText("203.0.113.1", { exact: true })).toHaveCount(0);
});

for (const failure of [
  {
    name: "upstream error",
    status: 502,
    json: { error: "IPinfo returned HTTP 429. Try again later." },
    message: "IPinfo returned HTTP 429. Try again later.",
  },
  {
    name: "malformed success response",
    status: 200,
    json: { ip: "not-an-ip", country: "US" },
    message: "Could not read a valid proxy test result. Try again.",
  },
]) {
  test(`Test handles ${failure.name} and allows retry without country data`, async ({
    page,
  }) => {
    await mockApi(page, fixture());
    let attempts = 0;
    await page.route(
      "**/console/api/config/proxy-groups/US/proxies/us-1/test",
      (route) => {
        attempts += 1;
        return route.fulfill(
          attempts === 1
            ? {
                status: failure.status,
                json: failure.json,
              }
            : { json: { ip: "203.0.113.7", country: null } },
        );
      },
    );
    await page.goto("/console/proxies");
    const button = page.getByRole("button", { name: "Test", exact: true });
    await button.click();
    await expect(page.getByRole("alert")).toHaveText(failure.message);
    await expect(button).toBeEnabled();
    await button.click();
    await expect(
      page.getByRole("img", { name: "Unknown country", exact: true }),
    ).toHaveText("🌐");
    await expect(page.getByText("203.0.113.7", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(attempts).toBe(2);
  });
}

for (const change of ["edit", "edit-node", "delete", "navigate"] as const) {
  test(`an in-flight Test is cancelled on ${change} and its late result is discarded`, async ({
    page,
  }) => {
    await mockApi(page, twoNodeFixture());
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/console/api/config/proxy-groups/US/proxies/us-1/test",
      async (route) => {
        await waiting;
        await route.fulfill({ json: { ip: "203.0.113.99", country: "US" } });
      },
    );
    await page.goto("/console/proxies");
    const first = page
      .getByRole("row")
      .filter({ hasText: "socks5://us.test:1080" });
    const requested = page.waitForRequest((request) =>
      request.url().endsWith("/us-1/test"),
    );
    await first.getByRole("button", { name: "Test", exact: true }).click();
    await requested;
    const cancelled = page.waitForEvent("requestfailed", (request) =>
      request.url().endsWith("/us-1/test"),
    );
    if (change === "edit" || change === "edit-node") {
      await page
        .getByRole("button", {
          name: change === "edit" ? "Configure US" : "Edit proxy us-1 in US",
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("SOCKS5 URL")
        .first()
        .fill("socks5://updated.test:1080");
      await dialog
        .getByRole("button", {
          name: change === "edit" ? "Save group" : "Save proxy",
          exact: true,
        })
        .click();
      await expect(dialog).toBeHidden();
    } else if (change === "delete") {
      await first
        .getByRole("button", { name: "Delete proxy us-1 from US", exact: true })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog
        .getByRole("button", { name: "Remove from draft", exact: true })
        .click();
      await expect(dialog).toBeHidden();
    } else {
      await page
        .getByRole("link", { name: "Client keys", exact: true })
        .click();
    }
    await cancelled;
    release();
    if (change === "navigate") {
      await page.getByRole("link", { name: "Proxies", exact: true }).click();
    }
    await expect(
      page.getByRole("columnheader", { name: "Exit IP", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("203.0.113.99", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Test", exact: true }).first(),
    ).toBeEnabled();
  });
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
