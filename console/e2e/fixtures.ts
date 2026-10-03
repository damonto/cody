import { resourceRequest } from "./configuration-resources";
import { maskSecrets } from "../../src/control/secrets";
import { expect, type Page } from "@playwright/test";
import type { Summary } from "../src/lib/api";
import type { GatewayConfig } from "../../src/config/types";

import type { AiGatewayProviderConfig } from "../../src/config/types";

import { versionSchema } from "../../src/admin/schema";
import { reportQuerySchema } from "../../src/reporting/query";
import { SECRET_PLACEHOLDER } from "../../src/shared/secrets";
import {
  DAY_MS,
  reportBucketMs,
  reportRange,
} from "../../src/reporting/ranges";

export interface ConfigurationView {
  version: number;
  actor: string;
  config: GatewayConfig;
}

const secret = SECRET_PLACEHOLDER;
export function draftFixture(): Omit<ConfigurationView, "config"> & {
  config: Omit<ConfigurationView["config"], "providers"> & {
    providers: AiGatewayProviderConfig[];
  };
} {
  return {
    version: 1,
    actor: "admin@example.test",
    config: {
      proxy_groups: [],
      providers: [
        {
          type: "ai_gateway",
          id: "example-provider",
          name: "example-provider",
          base_url: "https://upstream.example/v1",
          credentials: [
            {
              id: "primary",
              name: "primary",
              auth: { type: "api_key", api_key: secret },
              priority: 100,
              disabled: false,
            },
          ],
          priority: 100,
          disabled: false,
          supports_websocket: true,
          supports_context_management: false,
          supports_web_search: false,
          anthropic_1m_context: false,
          emulate_claude_code: false,
          models: ["example-model"],
          model_settings: { "example-model": { context_window: 1000000 } },
        },
      ],
      api_keys: [
        {
          id: "example-client",
          name: "example-client",
          api_key: secret,
          providers: ["example-provider"],
        },
      ],
      model_routes: {},
      web_search: { mode: "proxy" },
      reporting: { time_zone: "UTC", retention_days: 120 },
      model_prices: [
        {
          provider_id: "example-provider",
          model: "example-model",

          pricing: {
            currency: "USD",
            tiers: [
              {
                up_to_input_tokens: 200000,
                input: "3",
                output: "15",
                cache_write: "3.75",
                cache_read: "0.30",
              },
              {
                up_to_input_tokens: null,
                input: "6",
                output: "30",
                cache_write: "7.50",
                cache_read: "0.60",
              },
            ],
          },
        },
      ],
    },
  };
}
function maskKeys(
  config: ConfigurationView["config"],
): ConfigurationView["config"] {
  return {
    ...config,
    proxy_groups: config.proxy_groups.map((group) => ({
      ...group,
      proxies: group.proxies.map((node) => ({
        ...node,
        ...(node.password ? { password: secret } : {}),
      })),
    })),
    api_keys: config.api_keys.map((client) => ({ ...client, api_key: secret })),
    providers: config.providers.map((provider) =>
      provider.type !== "ai_gateway"
        ? provider
        : {
            ...provider,
            credentials: provider.credentials.map((key) => ({
              ...key,
              auth: { type: "api_key", api_key: secret },
            })),
          },
    ),
    web_search:
      config.web_search.mode === "proxy"
        ? config.web_search
        : { ...config.web_search, api_key: secret },
  };
}

function requiredKey(value: string | undefined, owner: string): string {
  if (value === undefined) {
    throw new Error(`${owner} has no credential in the test fixture`);
  }
  return value;
}

export async function mockApi(
  page: Page,
  initial: ConfigurationView = draftFixture(),
) {
  for (const entity of [
    ...initial.config.providers,
    ...initial.config.api_keys,
    ...initial.config.proxy_groups,
  ])
    entity.name ??= entity.id;
  for (const provider of initial.config.providers)
    for (const credential of provider.credentials)
      credential.name ??= credential.id;
  for (const group of initial.config.proxy_groups)
    for (const node of group.proxies) node.name ??= node.id;
  let draft = structuredClone(initial);
  for (const provider of draft.config.providers)
    for (const model of provider.models) {
      provider.model_settings ??= {};
      provider.model_settings[model] = {
        id: crypto.randomUUID(),
        ...provider.model_settings[model],
      };
    }
  let clientKeys = new Map(
    draft.config.api_keys.map((client) => [
      client.id,
      client.api_key === secret ? `test-key-${client.id}` : client.api_key,
    ]),
  );
  let providerKeys = new Map(
    draft.config.providers
      .filter((provider) => provider.type === "ai_gateway")
      .flatMap((provider) =>
        provider.credentials.map((key): [string, string] => [
          `${provider.id}:${key.id}`,
          key.auth.api_key === secret
            ? `test-key-${provider.id}-${key.id}`
            : key.auth.api_key,
        ]),
      ),
  );
  const search = draft.config.web_search;
  let searchApiKey =
    search.mode === "proxy"
      ? undefined
      : search.api_key === secret
        ? `test-search-key-${search.mode}`
        : search.api_key;
  function clientKey(id: string): string {
    return requiredKey(clientKeys.get(id), `Client ${id}`);
  }
  function providerKey(id: string, credentialId: string): string {
    return requiredKey(
      providerKeys.get(`${id}:${credentialId}`),
      `Provider ${id}/${credentialId}`,
    );
  }
  function searchKey(): string {
    return requiredKey(searchApiKey, "Web search");
  }
  draft.config = maskKeys(draft.config);
  const operations = new Map<
    string,
    { body: string; path: string; result: { version: number; item: unknown } }
  >();
  let loseSaveResponse = false;
  const calls: string[] = [];
  await page.route("**/console/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    let response: unknown = {};
    const clientReveal = url.pathname.match(
      /^\/console\/api\/clients\/([^/]+)\/reveal$/,
    );
    const providerReveal = url.pathname.match(
      /^\/console\/api\/providers\/([^/]+)\/credentials\/([^/]+)\/reveal$/,
    );
    const searchReveal =
      url.pathname === "/console/api/settings/web-search/reveal";
    if (
      ["POST", "PUT", "DELETE"].includes(request.method()) &&
      /^\/console\/api\/(providers|native-providers|clients|proxy-groups|settings|model-prices|model-routes)(?:\/|$)/.test(
        url.pathname,
      ) &&
      !url.pathname.endsWith("/reveal") &&
      !url.pathname.endsWith("/test")
    ) {
      const body = request.postDataJSON();
      const prior = operations.get(body.operation_id);
      if (prior) {
        expect(JSON.stringify(body)).toBe(prior.body);
        expect(`${request.method()} ${url.pathname}`).toBe(prior.path);
        await route.fulfill({ json: prior.result });
        return;
      }
      const input = resourceRequest(
        draft.config,
        url.pathname,
        request.method(),
        body,
      );
      expect(request.headers()["x-cody-admin"]).toBe("1");
      expect(body.version).toBe(draft.version);
      clientKeys = new Map(
        input.config.api_keys.map((client) => {
          const value =
            client.api_key === secret ? clientKey(client.id) : client.api_key;
          return [client.id, value];
        }),
      );
      providerKeys = new Map(
        input.config.providers
          .filter((provider) => provider.type === "ai_gateway")
          .flatMap((provider) =>
            provider.credentials.map((key): [string, string] => [
              `${provider.id}:${key.id}`,
              key.auth.api_key === secret
                ? providerKey(provider.id, key.id)
                : key.auth.api_key,
            ]),
          ),
      );
      const search = input.config.web_search;
      searchApiKey =
        search.mode === "proxy"
          ? undefined
          : search.api_key === secret
            ? searchKey()
            : search.api_key;
      draft = {
        ...draft,
        version: draft.version + 1,
        config: maskKeys(input.config),
      };
      const result = { version: draft.version, item: maskSecrets(input.item) };
      if (body.operation_id)
        operations.set(body.operation_id, {
          body: JSON.stringify(body),
          path: `${request.method()} ${url.pathname}`,
          result,
        });
      if (loseSaveResponse) {
        loseSaveResponse = false;
        await route.abort("failed");
        return;
      }
      response = result;
    } else if (url.pathname === "/console/api/config") {
      expect(request.method()).toBe("GET");
      response = {
        version: draft.version,
        actor: draft.actor,
        maintenance: 0,
        updated_at: 0,
      };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/providers"
    ) {
      response = { version: draft.version, item: draft.config.providers };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/clients"
    ) {
      response = { version: draft.version, item: draft.config.api_keys };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/proxy-groups"
    ) {
      response = { version: draft.version, item: draft.config.proxy_groups };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/model-prices"
    ) {
      response = {
        version: draft.version,
        item: draft.config.model_prices ?? [],
      };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/model-routes"
    ) {
      response = { version: draft.version, item: draft.config.model_routes };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/settings/reporting"
    ) {
      response = { version: draft.version, item: draft.config.reporting };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/console/api/settings/web-search"
    ) {
      response = { version: draft.version, item: draft.config.web_search };
    } else if (
      request.method() === "GET" &&
      url.pathname.startsWith("/console/api/native-providers/")
    ) {
      response = {
        version: draft.version,
        item:
          draft.config.providers.find(
            (provider) => provider.type === url.pathname.split("/").at(-1),
          ) ?? null,
      };
    } else if (
      (clientReveal || providerReveal || searchReveal) &&
      request.method() === "POST"
    ) {
      expect(request.headers()["x-cody-admin"]).toBe("1");
      const input = versionSchema.parse(request.postDataJSON());
      if (input.version !== draft.version) {
        await route.fulfill({
          status: 409,
          json: { error: "The draft changed; reload before viewing this key" },
        });
        return;
      }
      const api_key = clientReveal
        ? clientKeys.get(decodeURIComponent(clientReveal[1]))
        : providerReveal
          ? providerKeys.get(
              `${decodeURIComponent(providerReveal[1])}:${decodeURIComponent(providerReveal[2])}`,
            )
          : searchApiKey;
      if (!api_key) {
        await route.fulfill({
          status: 404,
          json: {
            error: clientReveal
              ? "Client does not exist"
              : providerReveal
                ? "Provider key does not exist"
                : "No search provider key is configured",
          },
        });
        return;
      }
      response = { api_key };
    } else if (url.pathname === "/console/api/config/names") {
      response = {
        names: Object.fromEntries(
          [...draft.config.providers, ...draft.config.api_keys].map(
            (entity) => [entity.id, entity.name ?? entity.id],
          ),
        ),
      };
    } else if (url.pathname === "/console/api/summary") {
      const query = reportQuerySchema.parse(
        Object.fromEntries(url.searchParams),
      );
      const range = reportRange(
        query.period,
        "UTC",
        Date.now(),
        query.from !== undefined && query.to !== undefined
          ? { from: query.from, to: query.to }
          : undefined,
      );
      response = {
        range,
        totals: {
          requests_count: 0,
          success_count: 0,
          failed_count: 0,
          cancelled_count: 0,
          incomplete_count: 0,
          missing_usage_count: 0,
          unpriced_count: 0,
          input_tokens: 0,
          uncached_input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          reasoning_tokens: 0,
          reasoning_samples: 0,
          cost_nano: 0,
          duration_sum: 0,
          duration_samples: 0,
          first_response_sum: 0,
          first_response_samples: 0,
          ttft_sum: 0,
          ttft_samples: 0,
          first_text_sum: 0,
          first_text_samples: 0,
        },
        currencies: {},
        pending: 0,
        series: [],
        bucket_ms: reportBucketMs(range),
        previous: null,
        ranking: {
          dimension: query.group_by,
          metric: query.sort_by,
          currency: query.cost_currency ?? "",
          items: [],
          other: null,
        },
        retention: { days: 120, from: Date.now() - 120 * DAY_MS },
        partial_history: false,
        updated_at: Date.now(),
      } satisfies Summary;
    } else if (url.pathname === "/console/api/report-options") {
      response = {
        providers: draft.config.providers.map((provider) => provider.id),
        models: draft.config.providers.flatMap((provider) => provider.models),
        clients: draft.config.api_keys.map((client) => client.id),
        time_zone: "UTC",
      };
    } else if (url.pathname === "/console/api/requests")
      response = { items: [], next_cursor: null };
    else if (url.pathname === "/console/api/pricing/version")
      response = { price: draft.config.model_prices![0] };
    else if (url.pathname === "/console/api/pricing/preview")
      response = {
        status: "complete",
        currency: "USD",
        tier_index: 1,
        context_tokens: 220000,
        input_nano: 360000000,
        output_nano: 120000000,
        cache_write_nano: 150000000,
        cache_read_nano: 84000000,
        total_nano: 714000000,
      };
    else if (
      url.pathname === "/console/api/pricing/history" ||
      url.pathname === "/console/api/config/versions" ||
      url.pathname === "/console/api/runtime/proxy-groups" ||
      url.pathname === "/console/api/runtime/clients"
    )
      response = { items: [] };
    if (
      request.method() === "GET" &&
      response &&
      typeof response === "object" &&
      "version" in response &&
      "item" in response
    ) {
      const value =
        url.pathname === "/console/api/settings/web-search"
          ? [response.item, searchApiKey]
          : response.item;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      );
      response = {
        ...response,
        etag: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
    }
    await route.fulfill({ json: response });
  });
  return {
    current: () => draft,
    clientKey,
    providerKey,
    searchKey,
    rotateSearchKey: (value: string) => {
      if (draft.config.web_search.mode === "proxy")
        throw new Error("Configure a search provider before rotating its key");
      searchApiKey = value;
      draft.version += 1;
    },
    calls,
    loseNextSaveResponse: () => {
      loseSaveResponse = true;
    },
  };
}

export function isConfigurationMutation(request: {
  method(): string;
  url(): string;
}): boolean {
  const path = new URL(request.url()).pathname;
  return (
    ["POST", "PUT", "DELETE"].includes(request.method()) &&
    /^\/console\/api\/(providers|native-providers|clients|proxy-groups|settings|model-prices|model-routes)(?:\/|$)/.test(
      path,
    ) &&
    !path.endsWith("/reveal") &&
    !path.endsWith("/test")
  );
}
