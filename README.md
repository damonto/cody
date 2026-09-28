# Cody Gateway

An AI API gateway with a web console, for Codex, Claude Code and other OpenAI- or Anthropic-compatible clients. It runs on Cloudflare Workers, as a Node.js server, or on Vercel.

- Manage AI Gateway, Antigravity and Codex providers, upstream credentials, client API keys and model aliases in the console.
- Route traffic through SOCKS5 proxy groups.
- View usage and costs for today, this week, this month and all time.
- Inspect request timing, token usage, caching, reasoning and context information.
- Set prices by provider and model, including different rates for larger contexts.

## Choose a platform

All platforms run the same gateway and console. Every build requires Node.js 24 or newer.

|                     | Cloudflare Workers | Node.js                        | Vercel                         |
| ------------------- | ------------------ | ------------------------------ | ------------------------------ |
| Database            | D1                 | SQLite, PostgreSQL or libSQL   | PostgreSQL or libSQL           |
| Also needs          | —                  | Redis                          | Redis                          |
| Console sign-in     | Cloudflare Access  | OIDC, Cloudflare Access, token | OIDC, Cloudflare Access, token |
| Responses WebSocket | Yes                | Yes                            | No                             |

libSQL works with [Turso](https://turso.tech/) or a self-hosted `sqld`.

## Cloudflare Workers

### Run locally

```bash
npm install
npm run dev:cloudflare
```

Open `http://localhost:8788/console/`. The gateway endpoint is `http://localhost:8788/v1`.

The first run creates `.dev.vars` with a new encryption key and a local database. Keep `.dev.vars`: if the key is lost, startup stops instead of replacing it, because existing data can only be read with the original key.

### Deploy

1. Create the Cloudflare resources:

   ```bash
   npx wrangler login
   npx wrangler kv namespace create CODY_CONFIG_KV
   npx wrangler d1 create cody
   npx wrangler queues create cody-usage
   npx wrangler queues create cody-usage-dlq
   ```

2. Put the returned KV namespace and D1 database IDs in [wrangler.jsonc](wrangler.jsonc).

3. Bind your domain to the Worker and protect the console with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/): create a self-hosted application for the path `console/*` and allow your administrator emails. In `wrangler.jsonc`, set `ACCESS_TEAM_DOMAIN` to `https://your-team.cloudflareaccess.com`, `ACCESS_AUD` to the application's AUD tag, and keep `ADMIN_LOCAL_DEV=false`.

4. Store an encryption key and deploy:

   ```bash
   openssl rand -base64 32
   npx wrangler secret put CONFIG_ENCRYPTION_KEY
   npm run deploy:cloudflare
   ```

`npm run deploy:cloudflare` builds the console, applies database migrations and deploys the Worker. `npm run build:cloudflare` builds and validates the Worker without deploying.

For automatic deployments, connect the repository to [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and use `npm run deploy:cloudflare` as the deploy command. The API token needs **D1 Edit** permission in addition to the Worker permissions.

## Node.js

You need a Redis server. SQLite is the default database; use PostgreSQL or libSQL when running more than one instance.

### Run locally

```bash
npm ci
cp .env.example .env
openssl rand -base64 32
```

Edit `.env`:

- `CONFIG_ENCRYPTION_KEY`: the generated key.
- `REDIS_URL`: your Redis server.
- `DATABASE_URL`: keep the default `sqlite:./data/cody.sqlite`, or use `postgres://user:password@host:5432/cody` or `libsql://your-database.turso.io?authToken=your-token`.

```bash
npm run build:node
npm run start:node
```

Open `http://127.0.0.1:8787/console/`. The gateway endpoint is `http://127.0.0.1:8787/v1`. The default `ADMIN_AUTH_MODE=local` signs you in automatically and only works while the server listens on `127.0.0.1`.

For development, `npm run dev:node` builds the console and restarts the server when source files change.

### Run in production

Before exposing the server, switch console sign-in to OIDC (see [Console sign-in](#console-sign-in-nodejs-and-vercel)) and set `HOST=0.0.0.0`.

With Docker:

```bash
docker build -t cody .
docker run -d -p 8787:8787 -v cody-data:/data --env-file .env -e DATABASE_URL=sqlite:/data/cody.sqlite cody
```

Inside the container, `127.0.0.1` refers to the container itself, so point `REDIS_URL` at a Redis address the container can reach.

Without Docker, `npm run build:node` produces a self-contained `dist/` directory; run it with `npm run start:node`, or copy `dist/` elsewhere and run `node --env-file=.env server.mjs` there. To update a server in place, run `npm run deploy:node`, which rebuilds `dist/` and applies database migrations, then restart the server.

Database migrations run automatically at startup; set `DATABASE_MIGRATE=false` to apply them only through `npm run deploy:node`. Behind a reverse proxy that terminates TLS, preserve the public `Host` header and set `X-Forwarded-Proto: https`.

## Vercel

You need a PostgreSQL or libSQL database and a Redis server that Vercel can reach. Place them near your function's region.

1. Import the repository into Vercel. Select Node.js 24 and leave **Root Directory** empty.
2. Add the environment variables:
   - `CONFIG_ENCRYPTION_KEY`: generate with `openssl rand -base64 32`.
   - `DATABASE_URL`: your PostgreSQL or libSQL connection string.
   - `REDIS_URL`: your Redis server.
   - `CRON_SECRET`: a random string of at least 16 characters.
   - Console sign-in variables (see [Console sign-in](#console-sign-in-nodejs-and-vercel)).
3. Deploy. Vercel runs `npm run deploy:vercel` (set in `vercel.json`), which builds and applies database migrations before release; a failed migration stops the deployment.

Open `/console/` on your deployment URL. Keep each preview environment on its own database and `REDIS_PREFIX`, separate from production.

Notes:

- Requests are limited by Vercel's function duration, 300 seconds by default. Set `VERCEL_MAX_DURATION` to change it within your plan's limit.
- Responses WebSocket is not available; clients must use HTTP.
- Console pages and assets are public; console APIs always require sign-in.
- To deploy a local build with `vercel deploy --prebuilt`, first run `npm run deploy:vercel` with the target database's `DATABASE_URL`.

## Console sign-in (Node.js and Vercel)

For browser sign-in, use any OIDC provider:

```dotenv
ADMIN_AUTH_MODE=oidc
ADMIN_OIDC_ISSUER=https://identity.example.com
ADMIN_OIDC_CLIENT_ID=cody
ADMIN_OIDC_CLIENT_SECRET=your-client-secret
ADMIN_OIDC_ALLOWED_EMAILS=admin@example.com,another-admin@example.com
```

Register `https://your-gateway/console/auth/callback` as the redirect URL. The provider must return verified email addresses.

Other modes:

- `ADMIN_AUTH_MODE=access`: behind Cloudflare Access, for example through a Cloudflare Tunnel. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
- `ADMIN_AUTH_MODE=token`: API access only, with `ADMIN_TOKEN` of at least 16 characters sent as `Authorization: Bearer …`.

## Set up the gateway

1. Open the console and add a provider under **Providers**:
   - **AI Gateway**: any OpenAI- or Anthropic-compatible upstream, with a base URL, models and API keys.
   - **Antigravity**: sign in with Google accounts, then enable it in its **Settings** dialog.
   - **Codex**: sign in with your own ChatGPT accounts (device code or pasted localhost callback), then choose models and enable it in its **Settings** dialog. See [Balance ChatGPT accounts](#balance-chatgpt-accounts).
2. Create a client key under **Client keys**.
3. Click **Publish**.

Set token prices in **Model pricing** and your reporting time zone in **Settings**. Cost estimates depend on the usage your upstream providers report.

To reuse a configuration, use **Settings → Export JSON** and **Settings → Import JSON**. Include secrets only when moving to another deployment; Antigravity and Codex accounts are not exported and must be signed in again. See [config.example.json](config.example.json) for the format.

Keep the encryption key unchanged for the life of a deployment and never commit it, `.env`, `.dev.vars` or configuration files with secrets.

## Use with clients

Other clients can use the gateway's OpenAI or Anthropic endpoints with a client key, sent as `Authorization: Bearer` or `x-api-key`.

### Codex

Add a provider to `~/.codex/config.toml`, replacing `base_url` with your gateway URL and choosing a configured model:

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://cody.example.com/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "cody" }

[model_providers.gateway.auth]
command = "printenv"
args = ["OPENAI_API_KEY"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

```bash
export OPENAI_API_KEY="your-gateway-client-key"
codex
```

#### Balance ChatGPT accounts

The **Codex** provider spreads Codex sessions across your own ChatGPT accounts and forwards requests to ChatGPT unchanged, over HTTP and WebSocket, including search, image generation, compaction and memories. It is meant for your own Codex clients, not for sharing a subscription with others.

- **Round robin** (default) gives each new session the next available account. **Session affinity** fills the first account before using the next.
- A session keeps its account until that account runs out of quota. The account then rests until its reported reset time, and the request is resent on another account before Codex sees the error.
- When every account is exhausted, Codex receives a usage-limit error with the earliest reset time.
- Each account card shows the plan, the 5-hour, weekly and other quota windows, credits and available resets. **Reset** spends one reset credit after confirmation. **Use resets automatically** in **Settings** spends the earliest-expiring credit only when every account is exhausted; it is off by default.

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://cody.example.com"
export ANTHROPIC_API_KEY="your-gateway-client-key"
claude --model "your-configured-model"
```

## SOCKS5 proxies

Create proxy groups, such as **US** or **UK**, on the **Proxies** page, then select a group on a provider's **Connection** tab or on an individual credential. Each group picks nodes by one of three strategies:

- **Random**: any healthy node.
- **Sticky**: a random healthy node at first, then keeps using it.
- **Priority**: the healthy node with the highest priority.

A node that fails repeatedly is paused for a few minutes. Requests never bypass a proxy by connecting directly. On Cloudflare, the proxy must be [reachable from Workers](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

## Move between platforms

Configuration moves through **Export JSON** / **Import JSON** in the console. On Node.js you can also import a file into an empty database:

```bash
npm run config:validate -- config.json
npm run config:import -- config.json
```

To copy request history between Cloudflare D1 and a Node.js or Vercel database, in either direction:

```bash
npm run reporting:transfer -- --from d1 --to "libsql://your-database.turso.io?authToken=your-token"
npm run reporting:transfer -- --from "postgres://user:password@host:5432/cody" --to d1
```

Both databases must already be set up. Rerunning the command only copies new requests; `--dry-run` counts without copying.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

## Claude accounts

The Claude provider balances the operator's own Claude subscriptions for native Claude Code clients. Add accounts under **Providers → Claude**, authorize in the browser, then paste the returned `code#state` or the complete official callback URL. Discover and select models in Settings, enable the provider, grant the client API key access to `claude`, and publish the draft.

Messages (including SSE), count-tokens and model discovery use the official Anthropic endpoint. Requests retain their prompts, tools, thinking signatures, metadata, beta headers and unknown fields. Only account authentication and explicitly configured model aliases change. Claude remote sessions, files, WebSocket and Resets are not supported in this version.

`account_selection` defaults to `round_robin`, distributing new sessions among the highest-priority available accounts. `session_affinity` fills the first available account in priority/configuration order. Both retain each Claude session's account until it becomes unavailable for the requested model. Opus-specific exhaustion does not disable Sonnet. Ordinary rate limits do not trigger account switching; explicit subscription quota rejection may switch accounts before any response reaches the client. Streams are never replayed.

Cards show the account/organization, reported subscription tier, usage windows, natural recovery times, Extra Usage and health. Extra Usage amounts are converted from upstream minor units; a null monthly limit means unlimited, and an upstream disabled reason prevents paid routing. Both named usage windows and active model-scoped `limits` are supported. Unknown fields remain unknown. Quotas refresh on demand with a 60-second cache; unavailable or stale quota data is not treated as free capacity.

`allow_extra_usage` defaults to `false`. When enabled, the gateway may select accounts with confirmed existing Extra Usage capacity after all subscription candidates are exhausted. It never enables billing, purchases credits or changes upstream limits. This is a routing preference, not a billing cap: concurrent traffic can cross upstream subscription limits before the next observation.

D1 and PostgreSQL require migration `0009_claude_oauth_accounts.sql`; SQLite and libSQL reuse the D1 migration. Use the existing platform deployment/migration commands. OAuth tokens remain encrypted outside configuration snapshots.
