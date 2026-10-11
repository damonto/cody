import { ApiProtocol } from "./protocol-values.ts";

export type { ApiProtocol } from "./protocol-values.ts";

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

/** Inference endpoints whose request usage is persisted and shown in reports. */
export const METERED_INFERENCE_PATHS = [
  "messages",
  "responses",
  "chat/completions",
  "images/generations",
  "images/edits",
] as const satisfies readonly InferencePath[];
export type MeteredInferencePath = (typeof METERED_INFERENCE_PATHS)[number];

export function isMeteredInferencePath(
  path: string | undefined,
): path is MeteredInferencePath {
  return METERED_INFERENCE_PATHS.some((endpoint) => endpoint === path);
}

export function inferenceAliases(path: InferencePath): string[] {
  return path === "messages" || path === "messages/count_tokens"
    ? [`/v1/${path}`]
    : [`/${path}`, `/v1/${path}`];
}

export type HttpExecutionEndpoint = InferencePath;

const HTTP_EXECUTION_ENDPOINTS = new Map<string, HttpExecutionEndpoint>([
  ...INFERENCE_PATHS.flatMap((path) =>
    inferenceAliases(path).map((alias): [string, HttpExecutionEndpoint] => [
      alias,
      path,
    ]),
  ),
]);

/** Only registered HTTP inference routes cross the execution boundary. */
export function httpExecutionEndpoint(
  request: Request,
): HttpExecutionEndpoint | undefined {
  return request.method === "POST"
    ? HTTP_EXECUTION_ENDPOINTS.get(new URL(request.url).pathname)
    : undefined;
}

/** Every endpoint the gateway routes, including the non-inference ones. */
export type GatewayEndpoint = "models" | "health" | "sessions" | InferencePath;

// The dialect each endpoint is defined in. `undefined` marks the endpoints that
// belong to neither dialect, where the client's own identity decides.
const ENDPOINT_PROTOCOLS: Record<GatewayEndpoint, ApiProtocol | undefined> = {
  messages: ApiProtocol.Anthropic,
  "messages/count_tokens": ApiProtocol.Anthropic,
  responses: ApiProtocol.Openai,
  "responses/compact": ApiProtocol.Openai,
  "alpha/search": ApiProtocol.Openai,
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
