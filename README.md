# Cody Gateway

An AI API gateway with a web console on Cloudflare Workers, for Codex and other OpenAI- or Anthropic-compatible clients.

- Manage AI Gateway providers, upstream credentials, client API keys, and model aliases in the console.
- View usage and costs for today, this week, this month, and all time.
- Inspect request timing, token usage, caching, reasoning, and context information.
- Set prices by provider and model, including different rates for larger contexts.

## Quick start

Requires Node.js 24 or newer.

```bash
npm install
npm run dev:setup
npm run dev
```

Open the console at `http://localhost:8788/console/`. Add an upstream provider and its models, create a client key, then **Publish**. The gateway endpoint is `http://localhost:8788/v1`.

Configure token prices in **Pricing** and your reporting time zone in **Settings**. Cost estimates depend on the usage reported by your upstream providers.

To import an existing configuration, use **Settings → Import JSON**. See [config.example.json](config.example.json) and [config.schema.json](config.schema.json) for the JSON format.

Configuration uses `providers` directly. Each `providers[]` entry declares `type: "ai_gateway"` and a non-empty `credentials` list, with secrets under `auth: { "type": "api_key", "api_key": "…" }`. Provider types and credential resolvers have separate extension points; native providers and OAuth are not enabled yet.

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

D1 initialization is consolidated in `migrations/0001_control_and_usage.sql`. Keep this filename stable so existing databases skip it. Add future schema changes in new migration files starting at `0007_*.sql`.

Use `npm run deploy:check` (or `npm run deploy -- --dry-run`) to build and validate the Worker bundle without applying migrations or deploying. The deploy script also accepts `--env`/`-e`, `--config`/`-c`, and repeated `--env-file` options; the same target settings are used for migration and deployment.

Open `/console/` on your domain to configure and publish your providers. The root `/` and `/console` redirect there. Keep the encryption key unchanged across deployments, and keep `config.json`, `config.local.json`, and `.dev.vars` out of Git.

For automatic deployments, connect `main` through [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and use `npm run deploy` as the deploy command. Its API token must include Account → D1 → Edit in addition to the Worker deployment permissions, so the same release can apply migrations.
