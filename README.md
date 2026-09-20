# Cody Gateway

An AI API gateway with a web console on Cloudflare Workers, for Codex and other OpenAI- or Anthropic-compatible clients.

- Manage AI Gateway and Antigravity providers, upstream credentials, client API keys, and model aliases in the console.
- View usage and costs for today, this week, this month, and all time.
- Inspect request timing, token usage, caching, reasoning, and context information.
- Set prices by provider and model, including different rates for larger contexts.

## Quick start

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

`npm run dev` prepares `.dev.vars` and applies pending **local** D1 migrations before starting. Existing settings and encryption keys are preserved. If the key is missing but configuration or OAuth data already exists, startup stops: restore the original `CONFIG_ENCRYPTION_KEY` in `.dev.vars` rather than generating a replacement. `npm run dev:setup` runs the same preparation without starting the server.

Open the console at `http://localhost:8788/console/`. Add an upstream provider and its models, create a client key, then **Publish**. The gateway endpoint is `http://localhost:8788/v1`.

Configure token prices in **Pricing** and your reporting time zone in **Settings**. Cost estimates depend on the usage reported by your upstream providers.

To import an existing configuration, use **Settings → Import JSON**. See [config.example.json](config.example.json) and [config.schema.json](config.schema.json) for the JSON format.

Configuration uses `providers` directly. AI Gateway supports multiple entries with `type: "ai_gateway"`, a `base_url`, and non-empty `models` and `credentials` lists with `auth: { "type": "api_key", "api_key": "…" }`. Antigravity is a fixed provider: at most one entry, with `type: "antigravity"` and the reserved ID `antigravity`. It uses official adapter endpoints (no `base_url`) and `auth: { "type": "oauth", "account_ref": "UUID" }`. Other native provider types are not accepted. Adapters and credential lifecycle resolvers are separate extension points.

The **Providers** submenu contains **AI Gateway** (`/console/providers/ai-gateway`) and **Antigravity** (`/console/providers/antigravity`). The old `/console/providers` address redirects to AI Gateway.

## Antigravity accounts

1. Start locally with `npm run dev`, or apply the D1 migrations and deploy the Worker as described below.
2. Open **Providers → Antigravity**. The page manages Google accounts and quotas directly; there is no provider creation form. The Google desktop OAuth client from CLIProxyAPI is built in.
3. Open **Settings** at the top right to configure priority, proxy, models, and **Routing & retry**. Antigravity starts disabled. Settings can be saved without accounts or models; keep it disabled until setup is complete. If direct Worker egress cannot reach Antigravity, create and **publish** a reachable SOCKS5 group first. OAuth always uses proxy nodes from the published snapshot. An account inherits its provider's group unless it selects another group; explicit Direct connection (`null`) bypasses the group.
4. Click **Add Google account**, then **Authorize with Google** and open the authorization link. No Provider ID or credential ID needs to be entered. Google sign-in uses the browser's network, not the Worker proxy.
5. After approval, copy the complete `http://localhost:51121/oauth-callback?...` URL from the browser address bar and paste it into the form. The localhost page is not expected to load. Each session has a random state, S256 PKCE and a ten-minute deadline. Authorization URLs/callbacks must not be shared or logged. See [Google's desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app).
6. The Worker exchanges the code, stores encrypted tokens, reads the Google identity, discovers a project with `loadCodeAssist`, and initializes it with `onboardUser` if needed. If project initialization fails, **Retry project initialization** reuses the saved tokens without redeeming the code again. A cancelled/expired session or failed token exchange requires a new authorization.
7. Click **Save account**. Open **Settings → Models** to select the real IDs returned by **Discover models**, enable the provider in **General**, then **Save settings**. Settings and accounts save independently to the draft. Add `antigravity` to the appropriate client keys and model routes, then **Publish**. An enabled Antigravity must have at least one account and model before publication. Accounts from abandoned forms or removed draft references can be recovered through **Add Google account → Use an existing account for this provider**.

The disabled Antigravity entry in `config.example.json` starts with empty accounts and models, matching the console. Authorize an account and select its discovered models before enabling it. A UUID alone cannot create credentials. Neither raw tokens nor authorization codes belong in configuration JSON or KV snapshots.

Each account has its own `ProviderOAuthAccount` Durable Object. Active and in-progress tokens are encrypted with `CONFIG_ENCRYPTION_KEY`; D1 stores only the non-sensitive account index. Access tokens refresh on demand within five minutes of expiry, with concurrent refreshes merged and stale results fenced. Refresh-token rotation is saved; `invalid_grant` requires reauthorization. Reauthorization updates the same account reference and must use the same Google identity. Publishing or rolling back configuration does not roll back tokens. Keep the encryption key backed up securely: changing it without a deliberate re-encryption migration makes existing configuration and account data unreadable.

**Remove from draft** removes only the account reference; it does not delete tokens or revoke a Google grant. **Manage → Disconnect** deletes that account's local tokens immediately, including for published configurations; revoke Google access separately in your Google account if desired.

Quotas are display-only: `retrieveUserQuotaSummary` is preferred, with `fetchAvailableModels` quota data used only for explicit unsupported HTTP statuses (404/405/501). Plan and available credits come from `loadCodeAssist`. Missing fields display Unknown, and failures retain the last successful snapshot with a stale marker. Results are cached for one minute and refresh every five minutes while the page is visible. Single-account and bulk refreshes are supported with at most six parallel operations. Quotas do not drive automatic account switching or enable paid credits. OAuth/quota failures do not affect inference health; confirmed proxy connection failures still update shared proxy health.

Antigravity supports ordinary and SSE `POST /v1/responses`, `POST /v1/messages`, and `POST /v1/messages/count_tokens`, including text/images, tools, structured output and thinking. Send full conversation history, including returned Responses `reasoning.encrypted_content` or Messages `thinking.signature` blocks in their original positions. The gateway's encrypted replay envelopes bind signed content to the client ID, provider, account and real upstream model; they work across Worker restarts and reject changed signed content. See [Responses manual item replay](https://developers.openai.com/api/docs/guides/migrate-to-responses).

This adapter does not support Chat Completions, WebSocket, remote compact, Astra history/notes, server-side `previous_response_id`, or credential-file import. Use the custom Codex provider below (not an OpenAI-native provider preset), so unsupported native context features are not requested. Retries keep the same provider, account, token and transformed request; only the configured retry policy applies.

For frontend hot reload, keep the Worker running and start `npm run dev:web` in another terminal, then open `http://localhost:5173/console/`.

## Use with Codex

Add this provider to `~/.codex/config.toml`, replacing `base_url` with your Worker URL and choosing a configured model:

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://cody.example.workers.dev/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "cody" }

[model_providers.gateway.auth]
command = "printenv"
args = ["OPENAI_API_KEY"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

Start Codex with a gateway client key matching an `api_keys[].api_key` entry:

```bash
export OPENAI_API_KEY="your-gateway-client-key"
codex
```

Other clients can use the gateway's OpenAI or Anthropic endpoints with the same client key, supplied through `Authorization: Bearer` or `x-api-key`.

For Claude Code, select a declared model or configured alias backed by an Antigravity provider and use the same gateway client-key permissions:

```bash
export ANTHROPIC_BASE_URL="https://cody.example.workers.dev"
export ANTHROPIC_API_KEY="your-gateway-client-key"
claude --model "your-configured-model"
```

For live acceptance, authorize a real Google account through its intended proxy, check project/model/quota results, and exercise both clients with two-turn text, image and tool requests (including returned thinking signatures), streaming cancellation and a forced reauthorization. Automated tests use simulated Google responses and cannot establish account eligibility or whether a particular egress IP is accepted by Google.

## SOCKS5 proxies

Manage groups such as **US** and **UK** on the console's **Proxies** page, then select a **Proxy group** on a provider's **Connection** tab or on an individual credential. Each node belongs to one group. SOCKS5 supports API requests, streaming, WebSockets, model catalogs, and native context management.

Groups are defined in the top-level `proxy_groups` array:

```json
{
  "proxy_groups": [
    {
      "id": "US",
      "strategy": "sticky",
      "proxies": [
        {
          "id": "us-primary",
          "url": "socks5://proxy.example.com:1080",
          "username": "proxy-user",
          "password": "proxy-password",
          "priority": 100,
          "disabled": false
        }
      ]
    }
  ]
}
```

- Set `providers[].proxy_group` to a group ID, or leave it unset/null for direct access. Credentials inherit by default; `providers[].credentials[].proxy_group` selects an independent group binding, and `null` explicitly selects direct access.
- Include the host and port in the URL. Supply username and password together, or omit both for a proxy without authentication.
- `random` chooses any healthy node uniformly, ignoring Priority. `sticky` does the same for its first assignment, then preserves the binding. `priority` chooses the highest Priority among healthy nodes and breaks ties randomly.
- Inherited credentials share the provider's sticky binding. Credentials explicitly selecting a group have their own binding, even when selecting the same group. Bindings survive deployments, priority changes, and added nodes. Disabling, removing, or cooling a node releases its bindings; recovery does not switch them back.
- Three proxy connection failures within one minute cool a node for five minutes. Successful connections reset its streak. All request types share proxy health, independently of provider/credential health. Target CONNECT refusals, HTTP errors, TLS errors, and client cancellation do not cool a proxy. Cooldowns expire passively and can also be cleared on the Proxies page.
- A logical request may switch to one other healthy node before sending any upstream HTTP headers or body. This allowance is shared with configured HTTP retries and never renews the existing timeout budget. A temporary sticky fallback changes the permanent binding only after its original node becomes unavailable. Established streams and WebSockets retain their connection.
- An empty or fully unavailable group, or an unavailable proxy state store, returns 503. Exhausted connection attempts return a connection error. Groups and nodes use stable IDs; group changes follow the existing draft/publish workflow, while live health reflects the published configuration.

Use a proxy [reachable from Cloudflare Workers](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). Proxy failures do not fall back to a direct connection.

Inline provider/credential `proxy` fields are no longer accepted. Configurations without these fields require no data migration: `proxy_groups` defaults to an empty list, and providers without a `proxy_group` use direct access.

## Deploy to Cloudflare

Create the required resources in your Cloudflare account:

```bash
npx wrangler login
npx wrangler kv namespace create CODY_CONFIG_KV
npx wrangler d1 create cody
npx wrangler queues create cody-usage
npx wrangler queues create cody-usage-dlq
```

Before deploying:

1. Put the returned KV namespace and D1 database IDs in [wrangler.jsonc](wrangler.jsonc).
2. Bind your domain to the Worker. Create a Cloudflare Access self-hosted application for `your-domain/console/*` (Path: `console/*`) and allow your administrator emails. This protects the console pages, assets, and `/console/api/*`; model API paths such as `/v1/*` continue to use client API keys. Set `ACCESS_TEAM_DOMAIN` to `https://your-team.cloudflareaccess.com`, set `ACCESS_AUD` to the application's AUD tag, and keep `ADMIN_LOCAL_DEV=false` in `wrangler.jsonc`. See [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
3. Generate a base64-encoded 32-byte encryption key and store it securely. Supply it when the following command prompts for `CONFIG_ENCRYPTION_KEY`:

```bash
npx wrangler secret put CONFIG_ENCRYPTION_KEY
npm run deploy
```

`npm run deploy` builds the console, applies unapplied D1 migrations to the remote `CODY_DB`, then deploys the Worker. A failed build or migration stops the release. Applied migrations are tracked by Wrangler and skipped on later deployments. The release runs non-interactively and uses your existing Wrangler login.

D1 initialization is consolidated in `migrations/0001_control_and_usage.sql`; keep this filename stable. `0007_oauth_accounts.sql` adds the OAuth account index; its unused `oauth_clients` table is retained for migration history. Durable Object migration v9 adds `ProviderOAuthAccount` after the existing v8 proxy-group migration; retain all earlier migrations, including the v7 health-class rename. Future D1 changes must use new filenames, not rewrite applied migrations.

Use `npm run deploy:check` (or `npm run deploy -- --dry-run`) to build and validate the Worker bundle without applying migrations or deploying. The deploy script also accepts `--env`/`-e`, `--config`/`-c`, and repeated `--env-file` options; the same target settings are used for migration and deployment.

Open `/console/` on your domain to configure and publish your providers. The root `/` and `/console` redirect there. Keep the encryption key unchanged across deployments, and keep `config.json`, `config.local.json`, and `.dev.vars` out of Git.

For automatic deployments, connect `main` through [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and use `npm run deploy` as the deploy command. Its API token must include Account → D1 → Edit in addition to the Worker deployment permissions, so the same release can apply migrations.
