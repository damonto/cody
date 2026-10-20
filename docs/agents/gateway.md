# Gateway behavior

Read this guide for routing, transport, retries, health, sessions, model aggregation or search. Read [Providers](providers.md) for native transformations and quota-switch exceptions.

## Request and routing contract

Start with `src/gateway/protocol.ts`, `src/gateway/routing/`, `src/gateway/http/` and `src/providers/index.ts`.

- Accept client credentials from `Authorization: Bearer` or `x-api-key`. Strip both before installing upstream credentials. Strip proxy metadata and hop-by-hop headers; preserve ordinary application headers.
- Reuse client-key digests only for the current committed configuration; key rotation and revocation must invalidate HTTP and WebSocket authentication promptly.
- Preserve AI Gateway and Codex bodies, query strings and responses. Rewrite the model only when routing requires it; remove digest/length headers invalidated by body changes. Native transformations belong in adapters, not gateway routing.
- Payload budgets live in `src/shared/payload-limits.ts`, with distinct constants for uploads, buffered responses, observation, retry inspection and WebSocket messages/queues. HTTP inference accepts 64 MiB on Node, narrowed by the runtime's `REQUEST_BODY_LIMIT_BYTES` to 16 MiB on Workers and 4,500,000 bytes on Vercel. Workers reserve memory for decoded text, JSON and adapter copies within the 128 MB isolate limit. Enforce the effective limit independently on uploaded and decoded bytes; error messages use the effective limit.
- Decode zstd inference uploads through a streaming decoder and the shared bounded reader for validation/routing; destroy the decoder on completion, cancellation or overflow. Do not classify output overflow through runtime-specific zlib error messages. Pass the decoded byte count to provider validation. Forward the original compressed bytes when unchanged; model rewrites and adapter bodies remove the stale encoding and digest headers. Reject malformed zstd with 400, unsupported encodings with 415 and oversized decoded bodies with 413.
- Antigravity Gemini families resolve to a physical variant before credential/health selection using the provider-owned reasoning resolver. Keep that model throughout retries, quota switching and metering price lookup; usage records the canonical family separately from the execution model; do not rewrite it only inside the adapter. Configured model eligibility is independent of default inference effort. Catalogs group configured variants and advertise discovered, enabled levels in low/medium/high order; missing enabled-variant metadata keeps shared limits unknown.
- All upstream HTTP, WebSocket and catalog calls use the provider adapter entry point. Adapters and credential resolvers are separate, typed extension points.
- Select enabled providers by descending priority, then configuration order, skipping cooldowns. Within AI Gateway, select the highest-priority enabled credential, breaking ties by configuration order. Native pools follow their own selection and quota policies.
- Resolve aliases per candidate provider: provider > client API key > global route. Intersect route provider restrictions with the client's allowed providers and use the selected provider's rewritten upstream model.
- Use `requestProtocol(request, endpoint)`: `anthropic-version` first, endpoint dialect second, then Claude user agent for neutral `models`, `health` and `sessions` endpoints. Keep the endpoint map in `protocol.ts`; do not infer it again from paths elsewhere.
- Return Anthropic-shaped errors to Anthropic clients, with error `type` derived from HTTP status. Diagnostic `code` values are OpenAI-only and remain available in request logs.

## Retries and streaming

- Apply only the selected provider's configured retry policy. Resolve authentication once and reuse the same request and credential snapshot for retries; do not switch credentials or providers as part of that policy. The documented Codex 401 recovery may refresh that same account once before output, without renewing the configured retry allowance or attempt deadline. The retry executor owns that limit and applies the provider's returned headers to subsequent attempts without mutating the original prepared headers.
- Match structured JSON/SSE error codes using the shared Diagnostic extractor only during bounded preflight, before forwarding starts. Explicit error envelopes do not require an error event name; output-bearing or successful terminal events still prohibit replay. Unknown events without explicit errors commit the stream; known empty lifecycle events may remain buffered only after content checks. Use raw upstream statuses for health and attempt logs before transforming final responses. AI Gateway returns the final upstream response unchanged; native adapters convert where required.
- Retry inspection buffers at most 16 MiB for up to ten seconds, within the remaining attempt budget. Responses lifecycle events may contain large echoed instructions and tool definitions; the byte limit covers the entire prefix, including those events. Coalesce small chunks in a buffer that grows within the limit, and release it on forwarding/cancellation. Return the prefix stop reason explicitly; a decisive event at the byte boundary takes precedence over the size limit. Discarded-attempt usage observation shares the byte limit so supported large failures retain reported usage. Size/time limits still commit the stream and prohibit later replay. An already exhausted budget skips preflight but preserves stream observation during downstream reads.
- Record each HTTP attempt's `retry_diagnostic` at the decision point, including the reason and bounded event/error identifiers when present. A later stream Diagnostic must not overwrite why preflight ended. Persist this optional v2 metadata in attempt details and show it in the console; historical attempts remain unrecorded. Never include raw SSE payloads or generated content in these diagnostics.
- Do not add implicit retries, replay WebSocket frames or fall back across providers after an upstream request starts. Native account switching is allowed only for the documented quota cases, before client output begins. Codex authentication recovery is a separate same-account HTTP/handshake exception; it never replays established WebSocket frames.
- Preserve cancellation, backpressure, timeout budgets and durable usage delivery when changing HTTP/SSE or WebSocket handling.
- HTTP inference separates upload/route validation (`http/inference-input.ts`), unavailable-account decisions (`http/inference-unavailable.ts`) and prepared-attempt execution (`http/inference-attempt.ts`). Provider response policies supply one typed account-switch action, including limit persistence and the exhausted response; `http/proxy.ts` alone orchestrates switching after a successful commit. Keep provider quota parsing and account RPC commands out of the HTTP executor. Pass the request signal to bounded upload reads for inference, configured search; the shared handler records an aborted upload as cancelled (499), before any upstream attempt.

## Session identity and affinity

Start with `src/gateway/sessions/` and `src/gateway/websocket/`.

Resolve the affinity session ID in this order:

1. `session-id` header.
2. `client_metadata.session_id`.
3. JSON-encoded `client_metadata["x-codex-turn-metadata"].session_id`.
4. Anthropic `metadata.user_id` JSON payload.
5. Top-level `id` for `alpha/search`.

- Claude Code carries its session only in `metadata.user_id`. All session bindings and indexes use the stable client ID, including ordinary inference. Fail closed if affinity storage is unavailable; do not introduce credential-keyed compatibility registries.
- Ordinary inference binds by client ID, Session ID and `ModelRoute.requestedModel`; aliases remain independent even when they resolve to the same upstream model. Preserve the client/session object address, store bindings under structured tuple digests, and fence each binding independently. Each has a 30-day idle expiry; the object alarm removes only expired entries and schedules the nearest remaining expiry.
- Session lists include the requested `model`, or `null` for unattributed bindings. Resolve index entries through the original Session ID, not the model digest. `DELETE /sessions/:id?model=…` clears only that model; omitting `model` clears all bindings for the session and returns their count.
- Conditional deletion fences against the observed binding ID and generation. Removing a stale index row must leave a surviving binding eligible for index repair on its next resolve, including after object eviction.
- Native Codex history/notes endpoints are unsupported. Model catalogs always disable `supports_experimental_context` and `model_messages.token_budget.use_history_notes_extension`; ingestion metadata does not change routing or pin accounts.
- The Responses WebSocket object accepts only Codex `response.create` frames; its status classification is OpenAI-shaped. Resolve the requested model's binding on every frame. Continue on the connected provider/credential, otherwise require client reconnection without replay. Report affinity storage failures as `session_affinity_unavailable`; only confirmed binding changes can request full input replay. Preserve v2 stored snapshots.
- WebSocket messages use a shared 32 MiB limit across Workers, Node and SOCKS5. Client and upstream processing each have a separate 32 MiB/1024-message buffer, including the active message and UTF-8 string bytes; the upstream reserves one terminal control event. Measure strings without allocating an encoded copy. Use one drain task per direction and explicit queues so close, failure and overflow release queued payloads without waiting for active I/O. Overflow closes the socket and rejects later frames. Upstream discard and connection replacement release queued payloads and listeners; replacement also closes the old socket. Failed acceptance releases the new socket and listeners. A normal upstream close drains earlier frames in order. Regression coverage: `tests/websocket-client-queue.test.mjs`, `tests/websocket-upstream.test.mjs`, `tests/standard-connections.test.mjs` and `tests/worker/websocket.test.ts`.
- WebSocket terminal logs retain the connection ID, bounded/redacted close reason, available clean-close flag, last response/event identifiers and time since the last upstream message. SOCKS5 transport failures log their read/write/protocol stage and byte counts with the same connection, provider and proxy IDs; cancellation is informational. Start socket teardown before invoking failure observers, and retain only routing identifiers and credential strings in their logging context. Bound and cycle-check TLS cause identifiers; never log cause messages, stacks, TLS key material or frame payloads. Regression coverage: `tests/websocket-transport.test.mjs`, `tests/log.test.mjs` and `tests/worker/websocket.test.ts`.

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
- Before switching nodes, retry proxy-scoped connection failures on the same node after 100, 300 and 500 ms, with each delay measured from the preceding failure. The initial connection and three retries share one health outcome: success clears the failure streak; exhaustion records one failure. Replacement nodes get the same retries without renewing the shared setup deadline or switch allowance. Check the remaining deadline before every dial and fallback, even when a timeout callback is delayed. Cancellation stops waits without recording a failure; setup deadlines stop retries and count at most one failure for the node.
- Three consecutive proxy connection failures in one minute cause five minutes of cooldown. Target CONNECT refusals, HTTP/TLS errors and client cancellation do not cool nodes. Proxy faults never count against provider/credential health.
- Keep proxy health observations alive with the caller's `waitUntil`, including OAuth account operations. Synchronous fallback waits must respect cancellation and the remaining setup deadline. A node switch still requires the preceding failure observation to commit successfully before selection; a terminal transport error must not wait indefinitely for health storage.
- Sticky inherited credentials bind by provider ID; explicit credential selections bind by provider ID plus credential ID. Persist bindings/cooldowns in the group object, fence late outcomes, and retain healthy bindings across edits and deployments.
- Prune removed owners only when synchronizing committed configuration. Preserve explicit overrides and disabled owners still referencing the group. Unsaved forms and partial OAuth snapshots must neither prune bindings nor resurrect removed owners.
- `proxies/coordination.ts` owns shared configuration fences, node reconciliation and sticky-selection decisions. Cloudflare SQL and standard-runtime storage adapters apply those decisions inside their own transactions; exercise both with `tests/helpers/proxy-binding-lifecycle.ts`.

## Catalog and web search

- Catalog fetches time out after three seconds and cache successful aggregates for a short, configurable isolate-local TTL. Node/Vercel also share these results in Redis, preserving the client/config/request cache key and original expiry; cache failures do not replace ordinary routing health checks.
- User agents containing `codex` receive `{models: [...]}`; other clients receive the standard model-list shape. A model served by Codex uses that account's upstream `ModelInfo` instead of the static catalog entry for Codex clients.
- Antigravity Codex models reuse explicitly selected static client metadata by real upstream ID or Gemini thinking family, before applying client aliases. Account limits, input modalities and enabled reasoning levels remain authoritative, including unknown limits for incomplete families. Only instruction fields from `model_messages` are reusable; templates must not enable unsupported native capabilities.
- `web_search` is global. Proxy mode sends `alpha/search` to providers with `supports_web_search`; Tavily/Exa modes execute in the gateway.
- Configured search requests use a 1 MiB upload budget, narrowed by the deployment ceiling. Search provider responses and the total query-batch response budget use separate 16 MiB constants in `src/shared/payload-limits.ts`; keep cancellation on either boundary.
- Tavily/Exa `prefer_native` decides per client key whether any enabled, reachable provider supports native search, without inspecting the request model. Once selected, do not fall back to the other mode.

Regression starting points: `tests/routing*.test.mjs`, `tests/retry-errors.test.mjs`, `tests/health.test.mjs`, `tests/models.test.mjs`, `tests/search.test.mjs`, `tests/proxy*.test.mjs` and the matching session/WebSocket/proxy tests in `tests/worker/`.
