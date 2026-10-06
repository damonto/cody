import { expect, test } from "@playwright/test";
import { newCodexProvider } from "../../tests/helpers/native-provider-fixtures";
import { draftFixture, mockApi, type ConfigurationView } from "./fixtures";

test("fresh pricing skips empty native providers and saves the first model price", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  initial.config.providers.unshift(newCodexProvider());
  initial.config.model_prices = [];
  const mock = await mockApi(page, initial);
  await page.goto("/console/pricing");
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toContainText("example-provider");
  await page
    .getByRole("button", { name: "Configure prices", exact: true })
    .click();
  for (const [label, value] of [
    ["Input", "2"],
    ["Output", "4"],
    ["Cache read", "0.5"],
    ["Cache write", "0"],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page
    .getByRole("button", { name: "Save model price", exact: true })
    .click();
  await expect
    .poll(
      () =>
        mock
          .current()
          .config.model_prices?.find(
            (price) => price.provider_id === "example-provider",
          )?.pricing?.tiers[0].input,
    )
    .toBe("2");
  await page.goto(
    "/console/pricing?provider=removed-provider&model=removed-model",
  );
  await expect(page.getByLabel("Input", { exact: true })).toHaveValue("2");
});

test("an explicitly selected provider without models keeps the provider switcher", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  const native = newCodexProvider();
  initial.config.providers.unshift(native);
  await mockApi(page, initial);
  await page.goto(`/console/pricing?provider=${native.id}`);
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toContainText("Codex");
  await expect(
    page.getByRole("link", { name: "Configure provider", exact: true }),
  ).toHaveAttribute("href", "/console/providers/codex");
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page
    .getByRole("option", { name: "example-provider", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save model price", exact: true }),
  ).toBeVisible();
});

test("an installation with no configured models provides a settings path", async ({
  page,
}) => {
  const initial: ConfigurationView = draftFixture();
  initial.config.providers = [newCodexProvider()];
  initial.config.model_prices = [];
  initial.config.api_keys = [];
  await mockApi(page, initial);
  await page.goto("/console/pricing");
  await expect(
    page.getByRole("combobox", { name: "Provider", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Configure provider", exact: true })
    .click();
  await expect(page).toHaveURL(/\/console\/providers\/codex$/);
});
