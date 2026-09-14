import { exaProvider } from "./exa.ts";
import { tavilyProvider } from "./tavily.ts";
import type { WebSearchProvider, WebSearchProviderMode } from "./types.ts";

type WebSearchProviderRegistry = {
  readonly [Mode in WebSearchProviderMode]: WebSearchProvider & {
    readonly mode: Mode;
  };
};

const WEB_SEARCH_PROVIDERS = Object.freeze({
  tavily: tavilyProvider,
  exa: exaProvider,
}) satisfies WebSearchProviderRegistry;

export function webSearchProviderFor(
  mode: WebSearchProviderMode,
): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS[mode];
}

export type {
  NormalizedSearchResult,
  WebSearchProvider,
  WebSearchProviderMode,
} from "./types.ts";

export { ProviderProtocolError } from "./shared.ts";
