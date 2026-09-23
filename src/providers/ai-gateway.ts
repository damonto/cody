import type { AiGatewayProviderConfig } from "../config/types.ts";
import {
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  upstreamUrl,
} from "../gateway/http/http.ts";
import { isContextManagementPath } from "../gateway/protocol.ts";
import {
  emulateClaudeCodeRequest,
  syntheticClaudeCodeIdentity,
} from "./claude-code.ts";
import type {
  PreparedUpstreamRequest,
  ProviderAdapter,
  ProviderRuntimeContext,
} from "./types.ts";

/**
 * Claude enables its 1M context window through this beta. Claude Code adds it
 * itself when the user picks a `[1m]` model variant and strips the suffix
 * before sending, so the upstream model name never carries `[1m]`.
 */
export const ANTHROPIC_1M_CONTEXT_BETA = "context-1m-2025-08-07";

/**
 * Merges the 1M context beta into the forwarded `anthropic-beta` header. The
 * client's own betas are kept in order and the beta is never duplicated. The
 * body is untouched, so routing, logging, metering and digests all stay valid.
 */
function addAnthropic1mBeta(headers: Headers): void {
  const betas = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0);
  if (betas.includes(ANTHROPIC_1M_CONTEXT_BETA)) return;
  headers.set(
    "anthropic-beta",
    [...betas, ANTHROPIC_1M_CONTEXT_BETA].join(","),
  );
}

/**
 * Applies `emulate_claude_code` to one Anthropic inference request. A request
 * that already looks like Claude Code's main loop is forwarded byte for byte;
 * any other (permission classifiers, connection tests, other clients) is
 * reshaped just enough for an upstream that only serves Claude Code traffic.
 */
async function emulateClaudeCode(
  prepared: PreparedUpstreamRequest,
  payload: Readonly<Record<string, unknown>>,
  model: string,
  clientId: string,
  sessionId: string | undefined,
  context: ProviderRuntimeContext | undefined,
): Promise<PreparedUpstreamRequest> {
  const emulated = emulateClaudeCodeRequest(
    payload,
    await syntheticClaudeCodeIdentity(clientId, sessionId),
  );
  if (!emulated) return prepared;
  // The body changes, so digests computed over the client bytes are stale.
  for (const name of [
    "content-md5",
    "digest",
    "content-digest",
    "content-encoding",
  ])
    prepared.headers.delete(name);
  context?.requestLog?.mergeSection("inference", {
    claude_code_emulation: "applied",
  });
  return { ...prepared, body: JSON.stringify({ ...emulated, model }) };
}

export const aiGatewayAdapter: ProviderAdapter<AiGatewayProviderConfig> = {
  type: "ai_gateway",
  supports(provider, endpoint, transport) {
    if (transport === "websocket") {
      return endpoint === "responses" && provider.supports_websocket;
    }
    if (isContextManagementPath(endpoint)) {
      return provider.supports_context_management;
    }
    if (endpoint === "alpha/search") {
      return provider.supports_web_search;
    }
    return true;
  },
  prepare(provider, credential, input, context) {
    const { request, endpoint, transport, protocol, payload, model } = input;
    const url = upstreamUrl(provider, endpoint, new URL(request.url).search);
    if (transport === "websocket") {
      return {
        url,
        headers: forwardWebSocketHeaders(request, credential.token),
      };
    }
    const headers = forwardRequestHeaders(request, credential.token);
    // Inference only: the model list and context-management calls carry no
    // Anthropic message body for the beta to apply to.
    if (
      provider.anthropic_1m_context &&
      protocol === "anthropic" &&
      endpoint !== "models" &&
      !isContextManagementPath(endpoint)
    ) {
      addAnthropic1mBeta(headers);
    }
    if (
      provider.emulate_claude_code &&
      protocol === "anthropic" &&
      endpoint === "messages" &&
      payload !== undefined &&
      model !== undefined &&
      input.clientId !== undefined
    ) {
      return emulateClaudeCode(
        { url, headers },
        payload,
        model,
        input.clientId,
        input.sessionId,
        context,
      );
    }
    return { url, headers };
  },
};
