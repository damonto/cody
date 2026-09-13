import { expect, type Page } from "@playwright/test";
import type { Draft, Summary } from "../src/lib/api";

import {
  draftSchema,
  reportQuerySchema,
  versionSchema,
} from "../../src/admin/schema";
import { SECRET_PLACEHOLDER } from "../../src/shared/secrets";
import {
  DAY_MS,
  reportBucketMs,
  reportRange,
} from "../../src/reporting/ranges";

const secret = SECRET_PLACEHOLDER;
export function draftFixture(): Draft {
  return {
    version: 1,
    published_revision: 1,
    valid: true,
    validation_error: null,
    actor: "admin@example.test",
    config: {
      services: [
        {
          id: "example-provider",
          base_url: "https://upstream.example/v1",
          keys: [
            { id: "primary", api_key: secret, priority: 100, disabled: false },
          ],
          priority: 100,
          disabled: false,
          supports_websocket: true,
          supports_context_management: false,
          supports_web_search: false,
          models: ["example-model"],
        },
      ],
      api_keys: [
        {
          id: "example-client",
          api_key: secret,
          services: ["example-provider"],
        },
      ],
      model_routes: {},
      web_search: { mode: "proxy" },
      reporting: { time_zone: "UTC", retention_days: 120 },
      model_policies: [
        {
          service_id: "example-provider",
          model: "example-model",
          context_window: 1000000,
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
function maskKeys(config: Draft["config"]): Draft["config"] {
  return {
    ...config,
    api_keys: config.api_keys.map((client) => ({ ...client, api_key: secret })),
    services: config.services.map((service) => ({
      ...service,
      keys: service.keys.map((key) => ({ ...key, api_key: secret })),
    })),
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

export async function mockApi(page: Page, initial = draftFixture()) {
  let draft = structuredClone(initial);
  let clientKeys = new Map(
    draft.config.api_keys.map((client) => [
      client.id,
      client.api_key === secret ? `test-key-${client.id}` : client.api_key,
    ]),
  );
  let serviceKeys = new Map(
    draft.config.services.flatMap((service) =>
      service.keys.map((key): [string, string] => [
        `${service.id}:${key.id}`,
        key.api_key === secret
          ? `test-key-${service.id}-${key.id}`
          : key.api_key,
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
  function serviceKey(id: string, keyId: string): string {
    return requiredKey(
      serviceKeys.get(`${id}:${keyId}`),
      `Service ${id}/${keyId}`,
    );
  }
  function searchKey(): string {
    return requiredKey(searchApiKey, "Web search");
  }
  draft.config = maskKeys(draft.config);
  const calls: string[] = [];
  await page.route("**/console/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    let response: unknown = {};
    const clientReveal = url.pathname.match(
      /^\/console\/api\/config\/clients\/([^/]+)\/reveal$/,
    );
    const serviceReveal = url.pathname.match(
      /^\/console\/api\/config\/services\/([^/]+)\/keys\/([^/]+)\/reveal$/,
    );
    const searchReveal =
      url.pathname === "/console/api/config/web-search/reveal";
    if (url.pathname === "/console/api/config") {
      if (request.method() === "PUT") {
        const input = draftSchema.parse(request.postDataJSON());
        expect(request.headers()["x-cody-admin"]).toBe("1");
        expect(input.version).toBe(draft.version);
        clientKeys = new Map(
          input.config.api_keys.map((client) => {
            const value =
              client.api_key === secret ? clientKey(client.id) : client.api_key;
            return [client.id, value];
          }),
        );
        serviceKeys = new Map(
          input.config.services.flatMap((service) =>
            service.keys.map((key): [string, string] => [
              `${service.id}:${key.id}`,
              key.api_key === secret
                ? serviceKey(service.id, key.id)
                : key.api_key,
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
      }
      response = draft;
    } else if (
      (clientReveal || serviceReveal || searchReveal) &&
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
        : serviceReveal
          ? serviceKeys.get(
              `${decodeURIComponent(serviceReveal[1])}:${decodeURIComponent(serviceReveal[2])}`,
            )
          : searchApiKey;
      if (!api_key) {
        await route.fulfill({
          status: 404,
          json: {
            error: clientReveal
              ? "Client does not exist"
              : serviceReveal
                ? "Service key does not exist"
                : "No search provider key is configured",
          },
        });
        return;
      }
      response = { api_key };
    } else if (url.pathname === "/console/api/config/publish") {
      draft.published_revision = (draft.published_revision ?? 0) + 1;
      response = draft;
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
        services: draft.config.services.map((service) => service.id),
        models: draft.config.services.flatMap((service) => service.models),
        clients: draft.config.api_keys.map((client) => client.id),
        time_zone: "UTC",
      };
    } else if (url.pathname === "/console/api/requests")
      response = { items: [], next_cursor: null };
    else if (url.pathname === "/console/api/pricing/version")
      response = { policy: draft.config.model_policies![0] };
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
      url.pathname === "/console/api/runtime/clients"
    )
      response = { items: [] };
    await route.fulfill({ json: response });
  });
  return {
    current: () => draft,
    clientKey,
    serviceKey,
    searchKey,
    calls,
  };
}
