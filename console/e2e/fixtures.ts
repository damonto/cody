import { expect, type Page } from "@playwright/test";
import type { Draft, Summary } from "../src/lib/api";

import { draftSchema, reportQuerySchema } from "../../src/admin/schema";
import { reportRange } from "../../src/reporting/ranges";

const secret = "__CODY_SECRET_UNCHANGED__";
function fixture(): Draft {
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
export async function mockApi(page: Page, initial = fixture()) {
  let draft = structuredClone(initial);
  const calls: string[] = [];
  await page.route("**/console/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    let response: unknown = {};
    if (url.pathname === "/console/api/config") {
      if (request.method() === "PUT") {
        const input = draftSchema.parse(request.postDataJSON());
        expect(request.headers()["x-cody-admin"]).toBe("1");
        expect(input.version).toBe(draft.version);
        draft = { ...draft, version: draft.version + 1, config: input.config };
      }
      response = draft;
    } else if (url.pathname === "/console/api/config/publish") {
      draft.published_revision = (draft.published_revision ?? 0) + 1;
      response = draft;
    } else if (url.pathname === "/console/api/summary") {
      response = {
        range: reportRange(
          reportQuerySchema.parse(Object.fromEntries(url.searchParams)).period,
          "UTC",
        ),
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
          ttft_sum: 0,
          ttft_samples: 0,
          first_text_sum: 0,
          first_text_samples: 0,
        },
        currencies: {},
        pending: 0,
        series: [],
        updated_at: Date.now(),
      } satisfies Summary;
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
  return { current: () => draft, calls };
}
