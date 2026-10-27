/** Wire-independent names shared by pricing, usage and the console. */
export const CACHE_WRITE_DURATION_GROUPS = {
  openai: {
    label: "OpenAI",
    durations: [
      {
        price: "cache_write_30m",
        tokens: "cache_write_30m_tokens",
        wire: "ttl_30m_tokens",
        label: "Cache write · 30 minutes",
      },
      {
        price: "cache_write_12h",
        tokens: "cache_write_12h_tokens",
        wire: "ttl_12h_tokens",
        label: "Cache write · 12 hours",
      },
    ],
  },
  anthropic: {
    label: "Claude",
    durations: [
      {
        price: "cache_write_5m",
        tokens: "cache_write_5m_tokens",
        wire: "ephemeral_5m_input_tokens",
        label: "Cache write · 5 minutes",
      },
      {
        price: "cache_write_1h",
        tokens: "cache_write_1h_tokens",
        wire: "ephemeral_1h_input_tokens",
        label: "Cache write · 1 hour",
      },
    ],
  },
} as const;

export type CacheDurationFormat = keyof typeof CACHE_WRITE_DURATION_GROUPS;
export const CACHE_WRITE_DURATIONS = [
  ...CACHE_WRITE_DURATION_GROUPS.anthropic.durations,
  ...CACHE_WRITE_DURATION_GROUPS.openai.durations,
] as const;

export type CacheWriteDuration = (typeof CACHE_WRITE_DURATIONS)[number];
export const CACHE_WRITE_DURATION_FIELDS: readonly CacheWriteDuration["tokens"][] =
  CACHE_WRITE_DURATIONS.map(({ tokens }) => tokens);
