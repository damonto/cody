import { ApiProtocol } from "./protocol-values.ts";

export type { ApiProtocol } from "./protocol-values.ts";

export const CONTEXT_MANAGEMENT_PATHS = [
  "alpha/history/v2/list_windows",
  "alpha/history/v2/list_items",
  "alpha/history/v2/read_item",
  "alpha/history/v2/search_contents",
  "alpha/notes/v2/list_files_by_prefix",
  "alpha/notes/v2/read_file",
  "alpha/notes/v2/search_contents",
  "alpha/notes/v2/append_to_file",
  "alpha/notes/v2/write_file",
  "alpha/notes/v2/thread_hint",
] as const;

export type ContextManagementPath = (typeof CONTEXT_MANAGEMENT_PATHS)[number];

export function isContextManagementPath(
  path: string,
): path is ContextManagementPath {
  return CONTEXT_MANAGEMENT_PATHS.some((endpoint) => endpoint === path);
}

/** Inference paths the gateway forwards, relative to a provider's base URL. */
export const INFERENCE_PATHS = [
  "responses",
  "responses/compact",
  "alpha/search",
  "chat/completions",
  "images/generations",
  "images/edits",
  "memories/trace_summarize",
  "messages",
  "messages/count_tokens",
] as const;
export type InferencePath = (typeof INFERENCE_PATHS)[number];

export function inferenceAliases(path: InferencePath): string[] {
  return path === "messages" || path === "messages/count_tokens"
    ? [`/v1/${path}`]
    : [`/${path}`, `/v1/${path}`];
}

export type HttpExecutionEndpoint = InferencePath | ContextManagementPath;

const HTTP_EXECUTION_ENDPOINTS = new Map<string, HttpExecutionEndpoint>([
  ...INFERENCE_PATHS.flatMap((path) =>
    inferenceAliases(path).map((alias): [string, HttpExecutionEndpoint] => [
      alias,
      path,
    ]),
  ),
  ...CONTEXT_MANAGEMENT_PATHS.flatMap(
    (path): [string, HttpExecutionEndpoint][] => [
      [`/${path}`, path],
      [`/v1/${path}`, path],
    ],
  ),
]);

/** Only registered HTTP inference/context routes cross the execution boundary. */
export function httpExecutionEndpoint(
  request: Request,
): HttpExecutionEndpoint | undefined {
  return request.method === "POST"
    ? HTTP_EXECUTION_ENDPOINTS.get(new URL(request.url).pathname)
    : undefined;
}

/** Every endpoint the gateway routes, including the non-inference ones. */
export type GatewayEndpoint =
  "models" | "health" | "sessions" | InferencePath | ContextManagementPath;

// The dialect each endpoint is defined in. `undefined` marks the endpoints that
// belong to neither dialect, where the client's own identity decides.
const ENDPOINT_PROTOCOLS: Record<GatewayEndpoint, ApiProtocol | undefined> = {
  messages: ApiProtocol.Anthropic,
  "messages/count_tokens": ApiProtocol.Anthropic,
  responses: ApiProtocol.Openai,
  "responses/compact": ApiProtocol.Openai,
  "alpha/search": ApiProtocol.Openai,
  "alpha/history/v2/list_windows": ApiProtocol.Openai,
  "alpha/history/v2/list_items": ApiProtocol.Openai,
  "alpha/history/v2/read_item": ApiProtocol.Openai,
  "alpha/history/v2/search_contents": ApiProtocol.Openai,
  "alpha/notes/v2/list_files_by_prefix": ApiProtocol.Openai,
  "alpha/notes/v2/read_file": ApiProtocol.Openai,
  "alpha/notes/v2/search_contents": ApiProtocol.Openai,
  "alpha/notes/v2/append_to_file": ApiProtocol.Openai,
  "alpha/notes/v2/write_file": ApiProtocol.Openai,
  "alpha/notes/v2/thread_hint": ApiProtocol.Openai,
  "chat/completions": ApiProtocol.Openai,
  "images/generations": ApiProtocol.Openai,
  "images/edits": ApiProtocol.Openai,
  "memories/trace_summarize": ApiProtocol.Openai,
  models: undefined,
  health: undefined,
  sessions: undefined,
};

function isClaudeUserAgent(request: Request): boolean {
  return (
    request.headers.get("user-agent")?.toLowerCase().includes("claude") ?? false
  );
}

/**
 * Resolves the dialect a request is speaking. One upstream provider may serve
 * either dialect, so this is always derived from the request and never declared
 * per provider.
 *
 * Signals, strongest first:
 *   1. `anthropic-version`, which only Anthropic clients send.
 *   2. The endpoint's own dialect, since `/v1/messages` is Anthropic and
 *      `/v1/chat/completions` is OpenAI whatever the client calls itself.
 *   3. A Claude user agent, which decides only the dialect-neutral endpoints
 *      (`/v1/models`, `/health`, `/sessions`).
 */
export function requestProtocol(
  request: Request,
  endpoint?: GatewayEndpoint,
): ApiProtocol {
  if (request.headers.has("anthropic-version")) {
    return ApiProtocol.Anthropic;
  }
  const endpointProtocol =
    endpoint === undefined ? undefined : ENDPOINT_PROTOCOLS[endpoint];
  if (endpointProtocol !== undefined) {
    return endpointProtocol;
  }
  return isClaudeUserAgent(request)
    ? ApiProtocol.Anthropic
    : ApiProtocol.Openai;
}

export function isAnthropicProtocol(protocol: ApiProtocol): boolean {
  return protocol === ApiProtocol.Anthropic;
}
