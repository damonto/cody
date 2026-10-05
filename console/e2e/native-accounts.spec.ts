import { expect, test } from "@playwright/test";
import { draftFixture, mockApi } from "./fixtures";
import {
  newCodexProvider,
  newClaudeProvider,
  newXaiProvider,
} from "../../tests/helpers/native-provider-fixtures";
import { accountViewSchema } from "../../src/providers/oauth/schema";

for (const create of [newCodexProvider, newClaudeProvider, newXaiProvider]) {
  for (const loseResponse of [false, true]) {
    test(`${create().type}: account toggle persists${loseResponse ? " after a lost response" : ""}`, async ({
      page,
    }) => {
      const provider = create();
      provider.models = ["model"];
      provider.disabled = false;
      provider.credentials = ["one", "two"].map((name, index) => ({
        id: crypto.randomUUID(),
        name,
        priority: 100 - index,
        disabled: false,
        proxy_group: null,
        auth: { type: "oauth", account_ref: crypto.randomUUID() },
      }));
      const accounts = provider.credentials.map((credential) =>
        accountViewSchema.parse({
          account_ref: credential.auth.account_ref,
          provider_id: provider.id,
          status: "ready",
          email: `${credential.name}@example.test`,
          project_id: null,
          expires_at: Date.now() + 3600000,
          error: null,
          models: [],
          models_updated_at: null,
          models_error: null,
          quota: {
            groups: [],
            subscription: null,
            updated_at: Date.now(),
            stale: false,
            last_error: null,
          },
        }),
      );
      const fixture = draftFixture();
      const api = await mockApi(page, {
        ...fixture,
        config: {
          ...fixture.config,
          providers: [provider],
          api_keys: [],
          model_prices: [],
        },
      });
      await page.route("**/console/api/provider-accounts**", (route) => {
        const path = new URL(route.request().url()).pathname;
        const account = accounts.find((item) =>
          path.includes(item.account_ref),
        );
        return route.fulfill({
          json: path.endsWith("/health")
            ? { items: [] }
            : (account ?? { items: accounts }),
        });
      });
      const writes: { path: string; body: unknown }[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          request.url().includes("/credentials/")
        )
          writes.push({
            path: new URL(request.url()).pathname,
            body: request.postDataJSON(),
          });
      });
      await page.goto(`/console/providers/${provider.type}`);
      const first = provider.credentials[0]!;
      const card = page.locator(`[data-account-id="${first.id}"]`);
      await expect(card.getByRole("switch")).toBeChecked();
      if (loseResponse) api.loseNextSaveResponse();
      await card.getByRole("switch").click();
      if (loseResponse) {
        await page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
      }
      await expect(card.getByRole("switch")).not.toBeChecked();
      expect(writes).toHaveLength(loseResponse ? 2 : 1);
      expect(writes[0]?.path).toBe(
        `/console/api/providers/${provider.id}/credentials/${first.id}`,
      );
      if (loseResponse) expect(writes[1]).toEqual(writes[0]);
      expect(
        api.current().config.providers.find((item) => item.id === provider.id)
          ?.credentials,
      ).toEqual([{ ...first, disabled: true }, provider.credentials[1]]);
      await page.reload();
      await expect(card.getByRole("switch")).not.toBeChecked();
      await card.getByRole("switch").click();
      await expect(card.getByRole("switch")).toBeChecked();
      await page.reload();
      await expect(card.getByRole("switch")).toBeChecked();
      expect(
        api.current().config.providers.find((item) => item.id === provider.id)
          ?.credentials,
      ).toEqual(provider.credentials);
    });
  }
}
