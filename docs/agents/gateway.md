# Gateway behavior

Read this guide for routing, transport, retries, health, sessions, model aggregation or search. Read [Providers](providers.md) for native transformations and quota-switch exceptions.

## Request and routing contract

Start with `src/gateway/protocol.ts`, `src/gateway/routing/`, `src/gateway/http/` and `src/providers/index.ts`.

- Accept client credentials from `Authorization: Bearer` or `x-api-key`. Strip both before installing upstream credentials. Strip proxy metadata and hop-by-hop headers; preserve ordinary application headers.
- Preserve AI Gateway and Codex bodies, query strings and responses. Rewrite the model only when routing requires it; remove digest/length headers invalidated by body changes. Native transformations belong in adapters, not gateway routing.
- All upstream HTTP, WebSocket, catalog and context-management calls use the provider adapter entry point. Adapters and credential resolvers are separate, typed extension points.
- Select enabled providers by descending priority, then configuration order, skipping cooldowns. Within AI Gateway, select the highest-priority enabled credential, breaking ties by configuration order. Native pools follow their own selection and quota policies.
- Resolve aliases per candidate provider: provider > client API key > global route. Intersect route provider restrictions with the client's allowed providers and use the selected provider's rewritten upstream model.
- Use `requestProtocol(request, endpoint)`: `anthropic-version` first, endpoint dialect second, then Claude user agent for neutral `models`, `health` and `sessions` endpoints. Keep the endpoint map in `protocol.ts`; do not infer it again from paths elsewhere.
- Return Anthropic-shaped errors to Anthropic clients, with error `type` derived from HTTP status. Diagnostic `code` values are OpenAI-only and remain available in request logs.

## Retries and streaming

- Apply only the selected provider's configured retry policy. Resolve authentication once and reuse the same request and credential snapshot for retries; do not switch credentials or providers as part of that policy.
- Match structured JSON/SSE error codes only during bounded preflight, before forwarding starts. Use raw upstream statuses for health and attempt logs before transforming final responses. AI Gateway returns the final upstream response unchanged; native adapters convert where required.
- Do not add implicit retries, replay WebSocket frames or fall back across providers after an upstream request starts. Native account switching is allowed only for the documented quota cases, before client output begins.
- Preserve cancellation, backpressure, timeout budgets and durable usage delivery when changing HTTP/SSE or WebSocket handling.

## Session identity and context management

Start with `src/gateway/sessions/` and `src/gateway/websocket/`.

Resolve the affinity session ID in this order:

1. `session-id` header.
2. `client_metadata.session_id`.
3. JSON-encoded `client_metadata["x-codex-turn-metadata"].session_id`.
4. Anthropic `metadata.user_id` JSON payload.
5. Top-level `id` for `alpha/search`.

- Claude Code carries its session only in `metadata.user_id`. All session bindings and indexes use the stable client ID, including ordinary inference. Fail closed if affinity storage is unavailable; do not introduce credential-keyed compatibility registries.
- `supports_context_management` defaults to false. Native history/notes use a dedicated model-less handler, require a consistent `context.session_id`, and bootstrap new sessions from the client's effective Astra routes.
- Context sessions pin provider and credential and retain upstream ownership by client ID. Unavailable bindings fail closed; quota exhaustion does not move a pinned context session.
- Auxiliary history/notes calls make one upstream HTTP attempt, do not alter inference health, and preserve encrypted payloads and truncation headers.
- The Responses WebSocket object accepts only Codex `response.create` frames; its status classification is OpenAI-shaped. Preserve v2 stored snapshots.

## Health

Start with `src/gateway/health/health.ts` and `src/gateway/health/provider-health.ts`.

- Ten consecutive failed requests within five minutes trigger a 30-minute cooldown. A success resets the streak. Persist cooldowns across object eviction and deployments.
- A response updates at most one health scope. Preserve these mappings:

| Request/provider  | Provider failures  | Credential failures |
| ----------------- | ------------------ | ------------------- |
| OpenAI dialect    | 400, 503           | 402, 403            |
| Anthropic dialect | 500, 502, 503, 529 | 401, 403            |
| Codex provider    | 503                | 401, 402, 403       |

- Catalog/model-list application health is separate from inference health. OAuth and quota application errors do not count toward inference failure streaks; explicit quota cooldowns follow provider rules. Confirmed proxy connection faults update shared proxy health only.
- Schedule ordinary health writes with `ExecutionContext.waitUntil` in Workers; direct tests may use synchronous fallback. Quota writes that must precede a switch are awaited.
- `GET /health` and `/v1/health` expose only cooldowns visible to the authenticated key. `DELETE /health/{provider_id}` and its `/v1` alias clear one cooldown; `scope=catalog` selects catalog health.
- The console reads account cooldowns and their `quota` reason from `/console/api/provider-accounts/health`. Successful manual or automatic resets clear the affected account's inference cooldown.

## SOCKS5 transport

Start with `src/gateway/proxies/` and `src/gateway/transport/`.

- One logical request may switch nodes once within its selected group, only before any upstream HTTP bytes are sent. Keep authentication, the original timeout budget and the shared switch allowance across configured retries. Never fall back to direct access. Established streams and WebSockets retain their connection.
- Three consecutive proxy connection failures in one minute cause five minutes of cooldown. Target CONNECT refusals, HTTP/TLS errors and client cancellation do not cool nodes. Proxy faults never count against provider/credential health.
- Sticky inherited credentials bind by provider ID; explicit credential selections bind by provider ID plus credential ID. Persist bindings/cooldowns in the group object, fence late outcomes, and retain healthy bindings across edits and deployments.
- Prune removed owners only when synchronizing committed configuration. Preserve explicit overrides and disabled owners still referencing the group. Unsaved forms and partial OAuth snapshots must neither prune bindings nor resurrect removed owners.

## Catalog and web search

- Catalog fetches time out after three seconds and cache successful aggregates for a short, configurable isolate-local TTL.
- User agents containing `codex` receive `{models: [...]}`; other clients receive the standard model-list shape. A model served by Codex uses that account's upstream `ModelInfo` instead of the static catalog entry for Codex clients.
- `web_search` is global. Proxy mode sends `alpha/search` to providers with `supports_web_search`; Tavily/Exa modes execute in the gateway.
- Tavily/Exa `prefer_native` decides per client key whether any enabled, reachable provider supports native search, without inspecting the request model. Once selected, do not fall back to the other mode.

Regression starting points: `tests/routing*.test.mjs`, `tests/retry-errors.test.mjs`, `tests/health.test.mjs`, `tests/models.test.mjs`, `tests/search.test.mjs`, `tests/proxy*.test.mjs` and the matching session/WebSocket/proxy tests in `tests/worker/`.
