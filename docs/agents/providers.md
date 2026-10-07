# Provider adapters and accounts

Read the shared rules and the section for the provider being changed. Entry points are `src/providers/index.ts`, `src/providers/types.ts`, `src/providers/credentials.ts`, `src/providers/oauth/` and each provider's directory. Read [Gateway](gateway.md) when changing selection, retries or transport.

## Shared native account rules

- Native providers are fixed optional singletons, disabled by default. Credentials reference accounts owned by that provider. Store tokens encrypted in per-account objects using `CONFIG_ENCRYPTION_KEY`, never in config snapshots. Standard runtimes persist the equivalent object state in SQL.
- Reauthorization and refreshes are generation-fenced. Preserve account identity and omitted token fields; configuration save/restore must not restore old tokens. OAuth/quota application errors do not change inference failure health.
- `oauth/account.ts` owns token/session lifecycle, encryption and generation-fenced commits. `oauth/state.ts` validates provider-discriminated persisted state on load and before commit, retaining existing field names/defaults; `oauth/initialization.ts` applies provider initialization within that fence. `oauth/inventory.ts` owns model/quota/reset operations through narrow client and state interfaces, and `oauth/presentation.ts` projects account views.
- `account_selection: round_robin` defaults to rotating new sessions among the highest-priority available accounts. `session_affinity` fills the first available account in priority/configuration order. An available existing binding stays with its account rather than advancing rotation.
- Allocate round-robin bindings atomically in the session object through shared `rotation:<provider_id>` health objects, using the durable provider ID. Coordination failures fail closed. Preserve account provenance when quota switching is allowed.
- Account switching stays within the selected provider and stops before downstream output. Persist explicit quota limits before switching. Generic 429s use only configured retries. Context-management sessions remain pinned.
- Keep paid usage opt-in and never change upstream billing settings or spending limits. Tests mock paid entitlements and upstream calls.
- Adapters changing inference bodies provide `inferenceMetadata` from the final translated body. Response converters notify the optional metadata observer from original parsed upstream frames before rewriting or synthesizing fields; never report echoed client parameters as upstream evidence. Reuse parsing without an extra stream consumer. Observer failures must not interrupt conversion. Antigravity reads native `modelVersion`; xAI reads native Responses metadata.

## AI Gateway

Code: `src/providers/ai-gateway.ts`, `src/providers/claude-code.ts`.

- Use `Authorization: Bearer <key>` for every request dialect, stripping the client's credentials including `x-api-key`. Preserve upstream payloads and responses unless a configured route or adapter option requires a change.
- `anthropic_1m_context` merges `context-1m-2025-08-07` into the `anthropic-beta` header for Anthropic inference, preserving existing betas without duplicates. Never rewrite the model: `[1m]` is a client-side convention.
- `emulate_claude_code` is opt-in and applies only to Anthropic `messages`. A passing request has a system array starting with Claude Code's prompt prefix (or attribution immediately followed by the prefix), a JSON-string `metadata.user_id` with non-empty `device_id` and UUID `session_id`, and at least three core tools from `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`.
- Reshape only what those checks require. Reuse usable client device/session IDs; otherwise derive one synthetic conversation from the client API key. Declare missing core tools as stubs and set `tool_choice: none` when no tools were offered. Forward requests already passing the checks byte for byte; drop digest headers only on body change. OpenAI, catalog, count-tokens and WebSocket are untouched.

Tests: `tests/providers.test.mjs`, `tests/claude-code.test.mjs`.

## Antigravity

Code: `src/providers/antigravity/`.

- Use the built-in public desktop OAuth registration from CLIProxyAPI and official adapter endpoints. No custom base URL, client-registration settings or provider-specific Worker Secrets.
- OAuth completes after token and identity validation. Project setup runs independently in the encrypted account object. Query `loadCodeAssist`, then poll `onboardUser` with a 30-second request timeout until done. Retry unfinished operations and transient transport/HTTP failures using persisted alarms with 5–30 second backoff and a ten-minute deadline. Completed onboarding without a project ID and explicit operation errors stop automatic retries, including over HTTP 200. Keep tokens and the last upstream outcome on failure; manual initialization retries restart project lookup and tier selection. Only a real project ID makes a new account ready; reauthorization preserves the previous working credentials until setup succeeds.
- Selection uses the minimal `readiness` RPC before model cooldowns, skipping accounts still initializing. This check never catches up account alarms on Node/Vercel. Read failures fail closed; initialization never changes inference health.
- `initialization.ts` owns project polling and bounded retry rules; the account object owns encrypted state and fenced commits. Only classified upstream failures change project retry state. Storage failures propagate to the alarm runtime, and background operations use the committed proxy binding when the account is configured.
- Worker OAuth tests wait for the expected session/project state while driving scheduled alarms. An automatic alarm may already be running when `runDurableObjectAlarm` returns, so fixed trigger counts do not establish completion. Fixtures testing pending setup must keep `onboardUser` unfinished until explicitly released. Wait for the current step to commit before eviction or replacing mocks, and for the error state before testing manual recovery.
- When no project was assigned, honor the selected tier's `userDefinedCloudaicompanionProject` requirement and explicit `ineligibleTiers` before onboarding. Age/account verification takes priority over the project prerequisite. Parse Google RPC `ErrorInfo` on HTTP failures and completed operation errors as well. Retain actionable verification messages and validated Google HTTPS links in encrypted account state for the authenticated console; never log challenge URLs. Stop automatic retries until the user completes verification and retries. Never substitute a shared project ID. A real assigned project remains usable regardless of an unrelated tier's eligibility or the tier flag.
- `Credits.credit_amount` is an implicit-presence proto3 int64 in the official Antigravity 2.19.1 protocol. An omitted/null amount in a credit entry means zero; a missing credit inventory is not a known zero balance. Preserve integer strings without precision loss. Credits are informational; never enable credit spending.
- Normalize tier eligibility fields and RPC metadata separately. Prefer Google's specific verification action (`ErrorInfo`, then `Help`) before a generic age-verification page. Merge repeated requirements without losing distinct instructions or help links; quota/subscription partial failures must retain both errors and the last successful data. Console verification actions must not hide a simultaneous refresh error.
- Follow CLIProxyAPI request conventions: native header whitelist, Messages-only conditional interleaved-thinking hint for Claude thinking models, and removal of Claude Code billing attribution. Keep the old identity prompt disabled.
- Optional `sensitive_words` masks system text only. Never mutate conversation/tool history or native signatures. Signed history may move among configured accounts only after verifying client, provider, model and original content; retain source-account provenance.
- Preserve available bindings across credential-priority recovery. `QUOTA_EXHAUSTED` and timed `RATE_LIMIT_EXCEEDED` cool the physical account and real upstream model, then permit an account switch before output. Inspect the first SSE event before committing the stream; later limits cool without replay. Unknown/capacity 429s only use configured retries.
- Persist quota cooldowns at `quota:antigravity:<account_ref>:<encoded model>`; lookup/write failures fail closed.
- Gemini `-low`, `-medium` and `-high` variants form a derived client-facing family when no real bare model is configured. Keep physical IDs in provider configuration and account discovery; catalogs, model selectors and the metered reporting model expose the family. `-tiered` and other suffixes stay independent. Explicit physical targets remain fixed.
- Resolve families before account selection and quota checks. Responses `reasoning.effort` and Messages `output_config.effort` select the variant; explicit thinking budgets take precedence (0–1024 low, 1025–8192 medium, larger high), and disabled/none selects low with disabled thinking parameters. Minimal maps to low; xhigh/max to high. Absent/auto/adaptive effort defaults to high. Missing configured levels are errors, never implicit fallback or configuration changes.
- Normalize reasoning into a typed mode before routing or native translation; reject malformed reasoning objects, unknown modes and empty efforts. Keep budget tables and native constraints inside `reasoning.ts`. Retries and quota account switches retain the resolved physical model, as do price lookup and replay signature scopes. Usage stores the canonical family in `model` and the execution variant in `upstream_model`. Responses retain the requested client model name. Signed history cannot cross physical variants; never strip or relax signatures to support an effort change.
- Cache public Hub version metadata separately from config/OAuth state and refresh through shared maintenance, never on the inference critical path.
- Node/Vercel direct transport uses pooled HTTP/1.1 without ALPN. SOCKS5 also omits ALPN; Worker direct `fetch` keeps the platform TLS implementation.

Tests: `tests/antigravity*.test.mjs` (including family routing/catalog coverage in `tests/antigravity-models.test.mjs`), `tests/worker/provider-oauth.test.ts`.

## Codex

Code: `src/providers/codex/`, `src/gateway/websocket/`.

- This provider balances the operator's own ChatGPT accounts; it is not a resale interface. Use Codex CLI public OAuth registration for device-code and pasted `http://localhost:1455/auth/callback` PKCE flows.
- Read `chatgpt_account_id` from the ID token; email is optional. Carry the FedRAMP claim into `X-OpenAI-Fedramp`. Partial refreshes preserve omitted fields and reject workspace changes.
- Forward HTTP/WebSocket to `https://chatgpt.com/backend-api/codex`, replacing account authorization and `ChatGPT-Account-ID`. Preserve client payloads; no instruction injection, client impersonation, forced streaming or unrelated field rewriting.
- Implemented endpoints are `responses`, `responses/compact`, `images/generations`, `images/edits`, `models`, `memories/trace_summarize`, plus `alpha/search` and context-management paths when their capability flags allow them. `memories/trace_summarize` is OpenAI-dialect inference served only by Codex.

### Quota switching

- A 429 with `usage_limit_reached`, `usage_not_included` or `insufficient_quota` terminates configured retries. Await a credential quota cooldown and resend on another account of the same provider only before client output.
- Resolve cooldown end from body `resets_at`, then the active limit's `x-codex-*-reset-at` headers, then a 15-minute fallback.
- WebSocket switching covers handshake 429 or a first-frame `error` before any other upstream event. Once output starts or the client sends a second frame, forward the error, cool the account and close; do not replay.
- When no account remains, return the last upstream 429. If all were already cooling, synthesize `usage_limit_reached` with the earliest `resets_at`. Pinned context sessions receive that error rather than moving.

### Reset credits

- `auto_consume_resets` defaults false. When enabled and all accounts are exhausted, one lease-serialized request may spend the earliest-expiring credit.
- Persist the selected credit and redeem request ID before consuming. Lease takeover replays the same operation, fences late owners and clears only the original quota cooldown. Manual retries retain both IDs.
- Manual consumption always requires confirmation. Credits are paid entitlements: mock them in tests.

Tests: `tests/codex.test.mjs`, `tests/worker/codex.test.ts`, `tests/worker/codex-websocket.test.ts`.

## Claude

Code: `src/providers/claude/`.

- Use public Claude Code PKCE registration with pasted `code#state` or the official callback URL. This provider serves the operator's own subscriptions.
- Serve Messages HTTP/SSE, count-tokens and models only. Preserve native bodies and application headers; never inject prompts, tools, beta headers or client fingerprints. Resets, remote sessions, files and WebSocket are unsupported.
- Filter fresh subscription quota before account selection. Keep five-hour, global weekly and model-specific weekly windows separate; persist model-scoped observations. Missing/stale quota fails closed.
- Explicit HTTP quota rejection may switch within Claude before output, never after SSE starts.
- `allow_extra_usage` defaults false and permits existing paid usage only after subscription candidates are exhausted. Never enable billing or change spending limits; concurrent requests may still cross the upstream billing boundary.

Tests: `tests/claude-provider.test.mjs`, `tests/worker/claude-provider.test.ts`.

## xAI

Code: `src/providers/xai/`.

- Use Grok CLI public device authorization; restrict discovery to HTTPS x.ai endpoints. Preserve encrypted storage, generation fencing and account identity through refreshes.
- OAuth inference uses `https://cli-chat-proxy.grok.com/v1/responses` with native CLI headers. Align Responses/Messages behavior with CLIProxyAPI, including an empty `instructions` default and native search tools. Preserve caller instructions rather than inventing an identity prompt.
- `inject_x_search` defaults false; when enabled, add `x_search` and filter internal search calls from client tool events. API keys, custom base URLs, WebSocket, compact and media generation are unsupported.
- Reasoning envelopes bind client ID, provider, account provenance, model and visible text. Preserve native encrypted content and tool IDs across validated pool switches.
- For recognized sessions, fill omitted reasoning and matching tool calls from the latest completed turn. Store replay state encrypted at dedicated `xai-replay:*` session-object addresses, with sliding one-hour TTL, bounded chunks and fenced writes. Account generation changes invalidate cached provenance; no process-local replay cache.
- Prefer fresh subscription quota. When fresh credits billing reports a zero on-demand cap and no prepaid balance, an unreported percentage may be checked through the actual inference request; this rule is independent of plan names. Otherwise unknown quota fails closed. Respect `allow_access: false`, authentication failures and persisted limits. `allow_extra_usage` defaults false; paid candidates require opt-in after subscription candidates are exhausted. Persist explicit limits before switching; generic 429s only use configured retries.
- Read `/settings` for subscription tier and access; fall back to the current access token's numeric `tier` claim, where explicit `0` means Free. Never infer Free from missing billing fields. Fetch credits and monthly billing independently; preserve partial data and per-source errors. Protobuf Cent `{}` is zero, while missing percentages stay unknown, never zero or derived from monthly spending. Keep subscription resets separate from billing rollovers and never merge amounts with conflicting billing-period ends. Retain the previous snapshot when neither billing data nor a plan is available.
- Approximate count-tokens uses server-only `o200k_base`, makes no upstream call and records no billable inference.

Tests: `tests/xai*.test.mjs`, `tests/worker/xai-provider.test.ts`.
