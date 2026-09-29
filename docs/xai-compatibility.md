# xAI compatibility with CLIProxyAPI

The HTTP Responses/Messages adapter is compared against the checked-in
CLIProxyAPI revision `673131f5`. OAuth, billing and inference tests use mocks.

## Aligned behavior

- Use the public Grok CLI OAuth registration, discovery endpoints and CLI
  headers, including client version `0.2.120`.
- Preserve partial refresh fields. Recognize device-flow errors independently
  of HTTP status, and recognize flat, nested and message-only credential errors.
- Default missing `instructions` to an empty string. The reference
  `normalizeCodexInstructions` function does **not** inject an identity prompt.
- Preserve sampling/output controls, including `top_k`.
- Support declared native `x_search` and `web_search` tools. The
  `inject_x_search` provider setting defaults to false, matching the reference.
  Enabling it adds `x_search` once, includes it in `allowed_tools`, and reserves
  a slot when deciding whether namespaces must be folded.
- Hide internal X Search subtool traces from clients and compact output indices.
  Client tools use reversible names, so similarly named client tools are retained.
- Normalize Grok reasoning into Responses summary events. Retain done-only text,
  indexless output items and reasoning ciphertext supplied in the terminal event.
- Supplement omitted reasoning and matching tool calls using the most recent
  completed turn, with a sliding one-hour cache lifetime. Deduplicate supplied
  reasoning/calls and skip replay when visible assistant history differs.
  A successful turn without replayable state clears the previous entry.
- Recognize explicit free-quota exhaustion messages and the reference's
  24-hour fallback, without classifying ordinary rate limits as quota exhaustion.

## Runtime adaptation

The reference uses either process memory or its shared KV backend for history.
Cody uses encrypted, bounded chunks in dedicated `xai-replay:*` objects through
the existing session namespace. Cloudflare, Node and Vercel share the same core.
No existing affinity object address or migration is changed.

Cache addresses bind the stable client ID, provider, real model and session key.
Stored provenance includes the source account and OAuth generation. Disconnects
or reauthorization invalidate that provenance. Each request receives a write
version so an older completion cannot replace a newer request's state. Cache
errors are diagnostic and do not affect inference health.

Reasoning returned to clients remains authenticated and encrypted. Client-supplied
reasoning is verified before replay; enabling automatic history does not permit
unsigned or cross-client reasoning injection.

## Remaining boundaries

- This adapter serves Responses/Messages HTTP/SSE. API-key authentication,
  custom upstream URLs, WebSocket, compact and media generation remain outside
  its current scope.
- Unlike the reference's permissive schema fallbacks, unsupported custom grammars
  and strict namespace combinations fail explicitly. Tools are not silently
  discarded or their input guarantees weakened.
- Quota eligibility, paid-usage opt-in, account rotation and configured retries
  retain Cody's durable routing policy. There is no extra automatic token-refresh
  retry after inference starts.
- Local token counting remains an estimate and excludes image encoding bytes.
  It does not contact OAuth, billing, inference or history-cache backends.

The principal reference files are `internal/auth/xai/xai.go`,
`internal/runtime/executor/xai_executor_request.go`,
`internal/runtime/executor/xai_executor_response.go`,
`internal/runtime/executor/xai_reasoning_replay.go`, and
`internal/cache/xai_reasoning_replay_cache.go` under `refs/CLIProxyAPI`.
