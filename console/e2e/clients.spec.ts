import { expect, test, type Page, type Route } from "@playwright/test";
import { draftSchema } from "../../src/admin/schema";
import { SECRET_PLACEHOLDER } from "../../src/shared/secrets";
import { mockApi } from "./fixtures";

const revealPath = "/console/api/config/clients/example-client/reveal";
const show = /Show Gateway API key/;
const hide = /Hide Gateway API key/;
const copy = /Copy client API key/;

async function clipboard(page: Page) {
  await page.addInitScript(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          text = value;
          return Promise.resolve();
        },
        write: async (items: ClipboardItem[]) => {
          text = await (await items[0].getType("text/plain")).text();
        },
        readText: () => Promise.resolve(text),
      },
    });
  });
}
const copied = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText());

test("saved client credentials stay hidden until requested and can be copied while hidden", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await clipboard(page);
  await page.goto("/console/clients");
  const value = mock.clientKey("example-client");
  const row = page.getByRole("row").filter({ hasText: "example-client" });
  const credential = row.getByRole("cell").nth(1);
  await expect(credential).toHaveText("sk-cody-******");
  await expect(credential.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("button", { name: /Show|Hide/ })).toHaveCount(0);
  expect(mock.calls.some((call) => call.includes("/reveal"))).toBe(false);
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);

  await row.getByRole("button", { name: copy }).click();
  await expect.poll(() => copied(page)).toBe(value);
  await expect(credential).toHaveText("sk-cody-******");
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);
  expect(mock.calls.filter((call) => call.endsWith(revealPath))).toHaveLength(
    1,
  );

  await page.reload();
  await expect(credential).toHaveText("sk-cody-******");
  await row.getByRole("button", { name: copy }).click();
  await expect.poll(() => copied(page)).toBe(value);
  expect(mock.calls.some((call) => call.startsWith("PUT"))).toBe(false);
});

test("viewing in the editor preserves the saved credential placeholder without a copy action", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/console/clients");
  await page.getByRole("button", { name: "Edit client" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("Gateway API key", { exact: true });
  const value = mock.clientKey("example-client");
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveValue("");
  await expect(dialog.getByRole("button", { name: copy })).toHaveCount(0);
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveValue(value);
  await expect(key).toHaveAttribute("type", "text");
  const saving = page.waitForRequest((request) => request.method() === "PUT");
  await dialog.getByRole("button", { name: "Save client" }).click();
  const submitted = draftSchema.parse((await saving).postDataJSON());
  expect(submitted.config.api_keys[0].api_key).toBe(SECRET_PLACEHOLDER);
  await expect(dialog).toBeHidden();
  expect(mock.clientKey("example-client")).toBe(value);
  expect(mock.calls.some((call) => call.endsWith("/config/publish"))).toBe(
    false,
  );
  await page.getByRole("button", { name: "Edit client" }).click();
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
});

test("new credentials use the sk-cody prefix and remain available after saving and reloading", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await clipboard(page);
  await page.goto("/console/clients");
  await page.getByRole("button", { name: "Create client" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("Gateway API key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  const initial = await key.inputValue();
  expect(initial).toMatch(/^sk-cody-[a-f0-9]{64}$/);
  await expect(dialog.getByRole("button", { name: copy })).toHaveCount(0);
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "Generate new key" }).click();
  const generated = await key.inputValue();
  expect(generated).toMatch(/^sk-cody-[a-f0-9]{64}$/);
  expect(generated).not.toBe(initial);
  await expect(key).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveAttribute("type", "text");
  await expect(key).toHaveValue(generated);
  await dialog.getByRole("button", { name: hide }).click();
  await expect(key).toHaveAttribute("type", "password");
  expect(mock.calls.some((call) => call.includes("/reveal"))).toBe(false);

  await dialog.getByLabel("Client ID").fill("new-client");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await expect(dialog).toBeHidden();
  expect(
    mock.current().config.api_keys.find((client) => client.id === "new-client")
      ?.api_key,
  ).toBe(SECRET_PLACEHOLDER);
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "new-client" });
  await row.getByRole("button", { name: copy }).click();
  await expect.poll(() => copied(page)).toBe(generated);
  await row.getByRole("button", { name: "Edit client" }).click();
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveValue(generated);
});

test("manual key edits survive visibility toggles and copy from the list after saving", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await clipboard(page);
  await page.goto("/console/clients");
  await page.getByRole("button", { name: "Edit client" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("Gateway API key", { exact: true });
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveValue(mock.clientKey("example-client"));
  await key.fill("my-custom-key");
  await expect(key).toHaveValue("my-custom-key");
  await dialog.getByRole("button", { name: hide }).click();
  await expect(key).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveValue("my-custom-key");
  await expect(key).toHaveAttribute("type", "text");
  expect(mock.calls.filter((call) => call.includes("/reveal"))).toHaveLength(1);
  await dialog.getByRole("button", { name: "Save client" }).click();
  await expect(dialog).toBeHidden();
  expect(mock.clientKey("example-client")).toBe("my-custom-key");
  await page.reload();
  await page.getByRole("button", { name: copy }).click();
  await expect.poll(() => copied(page)).toBe("my-custom-key");
});

test("failed reads keep credentials hidden, report the server error, and allow retry", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await clipboard(page);
  let status = 409;
  await page.route(`**${revealPath}`, (route) =>
    route.fulfill({
      status,
      json:
        status === 200
          ? { api_key: mock.clientKey("example-client") }
          : {
              error:
                status === 409
                  ? "The draft changed; reload before viewing this key"
                  : "Could not load the saved key",
            },
    }),
  );
  await page.goto("/console/clients");
  await page.getByRole("button", { name: copy }).click();
  await expect(
    page.getByText("The draft changed; reload before viewing this key"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: copy })).toBeEnabled();
  status = 503;
  await page.getByRole("button", { name: copy }).click();
  await expect(page.getByText("Could not load the saved key")).toBeVisible();
  expect(await copied(page)).toBe("");
  status = 200;
  await page.getByRole("button", { name: copy }).click();
  await expect.poll(() => copied(page)).toBe(mock.clientKey("example-client"));
  await expect(page.getByText("sk-cody-******", { exact: true })).toBeVisible();
});

for (const failure of ["write", "constructor"]) {
  test(`clipboard ${failure} failures produce feedback without revealing or persisting a key`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = await mockApi(page);
    await clipboard(page);
    await page.goto("/console/clients");
    await page.evaluate((failure) => {
      if (failure === "constructor") {
        Object.defineProperty(window, "ClipboardItem", {
          configurable: true,
          value: class {
            constructor() {
              throw new DOMException("Unsupported", "NotSupportedError");
            }
          },
        });
      } else {
        navigator.clipboard.write = () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError"));
      }
    }, failure);
    await page.getByRole("button", { name: copy }).click();
    await expect(page.getByText("Clipboard unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: copy })).toBeEnabled();
    await expect(
      page.getByText(mock.clientKey("example-client"), { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Edit client" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: show }).click();
    await expect(
      dialog.getByLabel("Gateway API key", { exact: true }),
    ).toHaveValue(mock.clientKey("example-client"));
    expect(errors).toEqual([]);
  });
}

test("leaving the client list cancels a pending copy and ignores the late key", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  await clipboard(page);
  const requests: Route[] = [];
  await page.route(`**${revealPath}`, (route) => {
    requests.push(route);
  });
  await page.goto("/console/clients");
  await page.getByRole("button", { name: copy }).click();
  await expect.poll(() => requests.length).toBe(1);
  const pending = requests.shift();
  if (!pending) throw new Error("Expected a pending copy request");
  await expect(page.getByRole("button", { name: copy })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();
  await pending.fulfill({ json: { api_key: "outdated-key" } });
  await page.getByRole("link", { name: "Client keys", exact: true }).click();
  await expect(page.getByRole("button", { name: copy })).toBeEnabled();
  await expect(page.getByText("sk-cody-******", { exact: true })).toBeVisible();
  expect(await copied(page)).toBe("");
  expect(errors).toEqual([]);
});

test("late key responses are ignored after hiding, editing, or closing the editor", async ({
  page,
}) => {
  await mockApi(page);
  const pending: Route[] = [];
  await page.route(`**${revealPath}`, (route) => {
    pending.push(route);
  });
  const finish = async () => {
    const route = pending.shift();
    if (!route) throw new Error("Expected a pending reveal request");
    await route.fulfill({ json: { api_key: "outdated-key" } });
  };
  await page.goto("/console/clients");
  await page.getByRole("button", { name: "Edit client" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("Gateway API key", { exact: true });
  await dialog.getByRole("button", { name: show }).click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(dialog.getByRole("button", { name: hide })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await dialog.getByRole("button", { name: hide }).click();
  await finish();
  await expect(dialog.getByRole("button", { name: show })).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(page.getByText("outdated-key", { exact: true })).toHaveCount(0);

  await dialog.getByRole("button", { name: show }).click();
  await expect.poll(() => pending.length).toBe(1);
  await key.fill("new-manual-key");
  await finish();
  await expect(key).toHaveValue("new-manual-key");
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveAttribute("type", "text");
  await expect(key).toHaveValue("new-manual-key");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Edit client" }).click();
  await dialog.getByRole("button", { name: show }).click();
  await expect.poll(() => pending.length).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await finish();
  await page.getByRole("button", { name: "Edit client" }).click();
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
});

test("a refreshed draft hides credentials without discarding unsaved form edits", async ({
  page,
  context,
}) => {
  await page.clock.install();
  const mock = await mockApi(page);
  await page.goto("/console/clients");
  await page.getByRole("button", { name: "Edit client" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel("Gateway API key", { exact: true });
  await dialog.getByRole("button", { name: show }).click();
  await expect(key).toHaveValue(mock.clientKey("example-client"));
  await dialog.getByRole("checkbox").uncheck();
  mock.current().version += 1;
  await page.clock.fastForward(31_000);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect
    .poll(
      () =>
        mock.calls.filter((call) => call === "GET /console/api/config").length,
    )
    .toBe(2);
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: show }).click();
  await expect(
    page.getByText("The draft changed; reload before viewing this key"),
  ).toBeVisible();
  await expect(key).toHaveValue("");
});
