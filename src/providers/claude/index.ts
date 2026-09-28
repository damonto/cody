import type { ClaudeProviderConfig } from "../../config/types.ts";
import { ProviderType } from "../../config/values.ts";
import { forwardRequestHeaders } from "../../gateway/http/http.ts";
import { ProviderTransport } from "../transport-values.ts";
import type { ProviderAdapter } from "../types.ts";
import { CLAUDE_BASE } from "./api.ts";

/** The operator's native Claude requests retain their original wire representation. */
export const claudeAdapter: ProviderAdapter<ClaudeProviderConfig> = {
  type: ProviderType.Claude,
  supports(_provider, endpoint, transport) {
    return (
      transport === ProviderTransport.Http &&
      ["messages", "messages/count_tokens", "models"].includes(endpoint)
    );
  },
  prepare(_provider, credential, input) {
    return {
      oauthGeneration: credential.generation,
      url: `${CLAUDE_BASE}/v1/${input.endpoint}${new URL(input.request.url).search}`,
      headers: forwardRequestHeaders(input.request, credential.token),
    };
  },
};
