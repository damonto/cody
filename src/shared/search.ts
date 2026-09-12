export const SEARCH_PROVIDERS = {
  tavily: {
    mode: "tavily",
    defaultBaseUrl: "https://api.tavily.com",
    maxResults: { default: 5, min: 0, max: 20 },
  },
  exa: {
    mode: "exa",
    defaultBaseUrl: "https://api.exa.ai",
    maxResults: { default: 10, min: 1, max: 100 },
  },
} as const;
