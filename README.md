# Cody Gateway

An AI API gateway with a web console, for Codex, Claude Code and other OpenAI- or Anthropic-compatible clients. It runs on Cloudflare Workers, as a Node.js server, or on Vercel.

- Manage AI Gateway, Antigravity, Codex and Claude providers, credentials, client keys and model aliases in the console.
- Route traffic through SOCKS5 proxy groups.
- Track usage, costs and request details, with custom pricing by provider and model.

Keep your deployment’s encryption key safe and unchanged. Never commit it or files containing secrets, such as `.env` and `.dev.vars`.

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

Open `http://127.0.0.1:5173/console/` for the console with hot reload. The gateway endpoint is `http://127.0.0.1:8787/v1`.

The first run creates a local database and `.dev.vars` with an encryption key. Keep this key: existing data depends on it.

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

`npm run deploy:cloudflare` builds the console, applies database migrations and deploys the Worker.

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

For development with hot reload, use `npm run dev:node` and open `http://127.0.0.1:5173/console/`. Keep `HOST=127.0.0.1` and `PORT=8787` in `.env`.

### Run in production

Before exposing the server, switch console sign-in to OIDC (see [Console sign-in](#console-sign-in-nodejs-and-vercel)) and set `HOST=0.0.0.0`.

With Docker:

```bash
docker build -t cody .
docker run -d -p 8787:8787 -v cody-data:/data --env-file .env -e DATABASE_URL=sqlite:/data/cody.sqlite cody
```

Inside the container, `127.0.0.1` refers to the container itself, so point `REDIS_URL` at a Redis address the container can reach.

Without Docker, use `npm run build:node` followed by `npm run start:node`. To update, run `npm run deploy:node`, then restart the server.

Behind a reverse proxy that terminates TLS, preserve the public `Host` header and set `X-Forwarded-Proto: https`.

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

Vercel supports HTTP only, with a default request timeout of 300 seconds.

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

## Use with clients

Use a client key created in the console and a model enabled in your published configuration.

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

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://cody.example.com"
export ANTHROPIC_API_KEY="your-gateway-client-key"
claude --model "your-configured-model"
```

## Move between platforms

Use **Settings → Export JSON / Import JSON** in the console to move configuration. OAuth accounts must be authorized again on the new deployment. See [config.example.json](config.example.json) for the configuration format.

Use `npm run reporting:transfer -- --help` for request-history transfer options between Cloudflare D1 and Node.js or Vercel databases.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```
