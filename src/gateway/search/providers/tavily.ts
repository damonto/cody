import { SEARCH_PROVIDERS } from "../../../shared/search.ts";
import {
  dateBeforeDays,
  nonBlankString,
  normalizeProviderResults,
  providerSearchUrl,
} from "./shared.ts";
import type { WebSearchProvider } from "./types.ts";

export const tavilyProvider = {
  ...SEARCH_PROVIDERS.tavily,
  maxDomains: { include: 300, exclude: 150 },

  buildRequest(config, input) {
    return new Request(providerSearchUrl(config.base_url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        max_results: config.max_results,
        include_answer: false,
        include_raw_content: false,
        ...(input.includeDomains === undefined
          ? {}
          : { include_domains: input.includeDomains }),
        ...(input.excludeDomains === undefined
          ? {}
          : { exclude_domains: input.excludeDomains }),
        ...(input.recency === undefined
          ? {}
          : { start_date: dateBeforeDays(input.recency) }),
      }),
    });
  },

  parseResponse(body) {
    return normalizeProviderResults(
      body,
      (result) => nonBlankString(result.content) ?? "",
    );
  },
} satisfies WebSearchProvider;
