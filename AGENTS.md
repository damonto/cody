# AGENTS.md

## Project overview

This repository contains a TypeScript Cloudflare Worker that serves as an AI API gateway for Codex and other clients.

## Runtime and tooling

- Use Node.js 24 or newer.
- Use `npm test` for the full test suite and `npm run typecheck` for TypeScript checks.
- Use `npm run lint` and `npm run format:check` before handing off changes. `lint` fails on warnings; `format:check` covers every tracked file except the generated ones listed in `.prettierignore`.
- Use `npm run config:validate -- config.json` before uploading configuration.
- Use `npx wrangler deploy --dry-run` to validate the Worker bundle without deploying.
- Do not commit `config.json`, `config.local.json`, `.dev.vars`, API keys, upstream credentials, or migration backups.

## Configuration invariants

- Configuration uses `providers` directly, without a schema-version field. Production only accepts the current configuration, v2 WebSocket snapshots, and v2 usage events. The one-time Provider conversion is complete; do not reintroduce legacy parsers or automatic compatibility upgrades.
- `providers[].type` accepts `ai_gateway` and `antigravity`. Antigravity is a fixed, optional singleton with the reserved ID `antigravity`; arbitrary IDs and duplicate native entries are rejected. AI Gateway remains multi-provider and cannot use that reserved ID. Provider adapters and credential resolvers are separate extension points. Other native providers must not be accepted until their implementations exist. Antigravity uses official adapter endpoints and rejects `base_url`. Do not add compatibility conversion for earlier Antigravity configurations.
- `providers[].models` contains only real upstream model names.
- AI Gateway always requires non-empty `models` and `credentials`. An enabled Antigravity requires both before publication; a disabled Antigravity may have empty arrays so settings and proxies can be published before OAuth setup. Drafts may temporarily contain an incomplete enabled Antigravity. Each credential has an ID unique within its provider and explicit `priority` and `disabled` fields. AI Gateway uses `auth: { type: "api_key", api_key: string }`; Antigravity requires `auth: { type: "oauth", account_ref: UUID }`. OAuth references must belong to their provider. Flat `api_key` fields and authentication types mismatched to the provider are rejected.
- Antigravity uses the built-in public desktop OAuth registration from CLIProxyAPI; do not add client registration settings or Provider-specific Worker Secrets. Account tokens reuse `CONFIG_ENCRYPTION_KEY`. Token/session state lives encrypted in per-account Durable Objects, not config snapshots. Reauthorization and refreshes are generation-fenced; config publication/rollback must not restore old tokens. OAuth/quota application errors never change inference health.
- Providers do not declare a protocol. One upstream may serve both dialects, so the dialect is always derived per request; a `providers[].protocol` field is rejected as unknown.
- SOCKS5 nodes live in top-level `proxy_groups`, with group strategies `random`, `sticky`, or `priority`. Provider/credential `proxy_group` fields reference groups; omitted credential fields inherit and null selects direct access. Inline `proxy` fields are rejected.
- `model_routes` is optional. Each route maps a client-facing model name to a real upstream `model` supported by at least one provider.
- `model_routes.*.providers` is optional. When present, every referenced provider must exist and list the route's upstream model; routing intersects this list with the authenticated client API key's allowed providers.
- `providers[].model_routes` is optional. Each route maps a client-facing model name to a real upstream `model` listed in that provider's `models`; provider-level routes must not include a `providers` field.
- Resolve routes per candidate provider with the priority `providers[].model_routes` > `api_keys[].model_routes` > global `model_routes`. The selected provider's route determines the rewritten upstream model.
- `providers[].retry` is optional and enables retries only when explicitly configured. Its `status_codes` and `delays_ms` arrays must both be empty or both be non-empty; the number of delays is the retry count.
- Client API keys may only reference declared providers, through `api_keys[].providers`.
- Keep the JSON schema, `config.example.json`, parser validation, and tests consistent when changing configuration.

## Request and routing behavior

- Preserve AI Gateway request bodies, query strings, headers, and upstream responses whenever possible. Only replace the gateway Authorization header, rewrite a model field when a route is configured, and remove headers that become invalid after rewriting. Native Antigravity transformations live in its adapter, not gateway routing. Use raw upstream statuses for retry/health before transforming final responses.
- The AI Gateway adapter authenticates upstream requests with `Authorization: Bearer <key>` for every request dialect. Client credentials, including `x-api-key`, are stripped before forwarding. All upstream HTTP, WebSocket, catalog, and context-management calls use the provider adapter entry point.
- Accept client credentials from either `Authorization: Bearer` or `x-api-key`, since the Claude Code SDK sends the latter.
- `providers[].anthropic_1m_context` merges the `context-1m-2025-08-07` beta into the `anthropic-beta` header of Anthropic-dialect inference requests, preserving the client's own betas and never duplicating it. It never rewrites the model name: `[1m]` is a Claude Code client-side convention that the client strips before sending, so upstreams only understand the beta header.
- Return Anthropic-shaped errors to Anthropic-protocol clients, with the `type` derived from the HTTP status via the documented Anthropic set. Diagnostic `code` values are OpenAI-only and remain in the request log.
- Resolve the affinity session id from the `session-id` header, then `client_metadata.session_id`, then Codex's JSON-encoded `client_metadata["x-codex-turn-metadata"].session_id`, then the Anthropic `metadata.user_id` JSON payload, then the `alpha/search` top-level `id`. Claude Code carries its session only in `metadata.user_id`.
- Select providers by descending priority, then configuration order, while skipping providers in cooldown.
- Within the selected provider, use the highest-priority enabled credential and break ties by configuration order. Credential switching is configuration-driven, not automatic.
- Apply only the selected provider's configured retry policy. Resolve authentication once before sending; retries resend the same request with the same credential snapshot, never switch credentials or providers. AI Gateway returns the final upstream response unchanged; native adapters convert it to the client dialect.
- Do not add retries beyond the configured policy or fallback to another provider after an upstream request has started unless the user explicitly requests that behavior.
- A logical request may switch SOCKS5 nodes once within its selected group, only before any upstream HTTP bytes are sent. Preserve Provider/Cred authentication, the existing timeout budget, and the shared switch allowance across configured HTTP retries; never fall back to direct access. Established streams and WebSockets keep their connection.
- Proxy nodes use independent health: three consecutive proxy connection failures within one minute cause five minutes of cooldown. All request types share this transport health; valid target CONNECT refusals, HTTP/TLS errors, and client cancellation do not cool proxy nodes. Proxy faults do not count against provider/credential health.
- Sticky proxy groups bind inherited credentials by provider ID and explicit credential selections by provider ID plus credential ID. Persist bindings and cooldowns in the group's Durable Object, fence late outcomes, and retain healthy bindings across configuration edits and deployments.
- Health tracking counts a failure streak only when 10 consecutive failed requests occur within a five-minute window. A success resets the streak; the cooldown lasts 30 minutes and persists in Durable Object storage across instance eviction and deployments.
- Resolve the request dialect with `requestProtocol(request, endpoint)`: the `anthropic-version` header first, then the endpoint's own dialect, then a Claude user agent for the dialect-neutral endpoints (`models`, `health`, `sessions`). `protocol.ts` owns the endpoint-to-dialect map; do not re-derive it from the path elsewhere.
- Failure statuses follow that request dialect. OpenAI counts 400 and 503 against the provider and 402 and 403 against the credential; Anthropic counts 500, 502, 503, and 529 against the provider and 401 and 403 against the credential. A status maps to at most one scope, so one response never records both.
- The Responses WebSocket Durable Object accepts only Codex `response.create` frames, so every status it classifies is OpenAI-shaped.
- `GET /health` and `/v1/health` list current inference cooldowns visible to the authenticated client API key. `DELETE /health/{provider_id}` and `/v1/health/{provider_id}` manually clear one inference cooldown. `scope=catalog` selects catalog health for either operation.
- Keep catalog/model-list provider and credential health separate from inference health. Catalog application failures must not change inference routing health; confirmed proxy transport failures update the shared proxy health described above.
- `supports_context_management` defaults to false. Native history/notes endpoints require a consistent `context.session_id` and use a dedicated model-less handler; new sessions bootstrap from the client's effective Astra routes.
- Context-management sessions pin their provider and credential, fail closed on unavailable bindings, and preserve upstream session ownership by client ID. Auxiliary history/notes calls make one upstream HTTP attempt and never alter inference provider/credential health; keep encrypted payloads and truncation headers intact.
- All session bindings and indexes use the stable client ID, including ordinary inference. Session requests fail closed if affinity storage is unavailable; do not add credential-keyed compatibility registries or choose identity based on current route capabilities.
- Schedule health writes with `ExecutionContext.waitUntil` in Workers; direct test callers may use synchronous fallback behavior.
- User-Agents containing `codex` receive the Codex `{models: [...]}` shape; other clients receive the standard model-list shape.

## Cloudflare deployment

- Configure the KV namespace and D1 database bindings in `wrangler.jsonc` for the target Cloudflare account before deployment.
- Use Cloudflare Workers Builds Git integration for automatic deployments from `main`; do not add a GitHub Actions deployment workflow unless the user explicitly requests one.
- Upload the validated JSON configuration to the `CODY_CONFIG_KV` binding after creating the namespace.
- Keep Durable Object migrations compatible with the deployed Worker. The v7 migration renames `ServiceHealth` to `ProviderHealth`; retain that history and stable object addresses.
- D1 initialization is consolidated in `migrations/0001_control_and_usage.sql`. Keep this filename stable: production already records it as applied. OAuth uses `0007_oauth_accounts.sql` and DO migration v9, after v8 proxy groups. Preserve this migration history and add future schema changes in new files. Use `npm run deploy` to apply pending D1 migrations before deployment.
- Model catalog fetches use a three-second timeout and cache successful aggregates for a short, configurable isolate-local TTL.
- Strip proxy metadata, client credentials, and hop-by-hop headers before forwarding; preserve ordinary application headers.

## Change and verification guidelines

Prefer small, focused changes. Add or update tests for routing, configuration validation, model aggregation, and health-window behavior. Run the full test suite, typecheck, configuration validation, and a Wrangler dry-run before handing off changes.

- Derive binding types from Wrangler's generated `Env`. Use narrow dependency types and runtime schemas at external boundaries instead of double type assertions.
- Keep provider adapters and credential resolvers specific to their discriminated configuration types. Preserve explicit request/result interfaces at these extension points.
- Give editable form rows stable identities independent of array position and editable IDs. Strip form-only metadata before saving configuration, and keep failed mutations visible and retryable.
- Antigravity's page manages accounts and quotas directly. Its top-right Settings dialog owns enabled state, priority, proxy, models, routes and retries; settings and account edits save independently to the draft. Default to disabled, keep IDs hidden, and do not expose native Provider creation/deletion. Only AI Gateway and Antigravity appear in the Providers submenu.
- Preserve the standard shadcn components and exports in `console/src/components/ui/`; do not prune them merely because they have no current callers.
- Keep console routes lazy-loaded and shared browser contracts independent of feature schemas. `npm test` checks the 500 kB minified JavaScript chunk budget and keeps reporting libraries out of the entry and non-reporting routes; fix import boundaries instead of raising the warning limit.
