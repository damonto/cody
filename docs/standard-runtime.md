# Native Node.js and Vercel

The same gateway and console run in all three environments. Cloudflare keeps its existing bindings and migration history. Native Node and Vercel use PostgreSQL or SQLite for durable state and Redis for coordination locks.

| Capability             | Cloudflare        | Native Node.js                    | Vercel                                  |
| ---------------------- | ----------------- | --------------------------------- | --------------------------------------- |
| HTTP and SSE inference | Yes               | Yes                               | Yes, within the function duration       |
| Responses WebSocket    | Yes               | Yes                               | No; returns 501                         |
| Database               | D1                | SQLite or Postgres                | Postgres                                |
| Database migrations    | During deployment | Before accepting requests         | After build, before release             |
| Coordination           | Durable Objects   | Redis                             | Redis                                   |
| Background recovery    | Alarms and cron   | Timers and persisted alarms       | Request activity and authenticated cron |
| Administrator sign-in  | Cloudflare Access | OIDC, Access, local, or API token | OIDC, Access, or API token              |

## Run Node locally

Use Node.js 24 or newer and a reachable Redis server. From the repository root:

```bash
npm ci
cp .env.example .env
openssl rand -base64 32
```

Put the generated key in `CONFIG_ENCRYPTION_KEY` in `.env`. Keep this key stable: it encrypts configuration, OAuth accounts and administrator cookies. Set `REDIS_URL` to your Redis connection string. The default `DATABASE_URL=sqlite:./data/cody.sqlite` creates a local database; alternatively set `DATABASE_URL=postgres://user:password@host:5432/cody`. URL-encode special characters in credentials. Use `rediss://` and the PostgreSQL server's SSL settings where required.

```bash
npm run build:node
npm start
```

Open `http://127.0.0.1:8787/console/`. Add providers and client keys, then publish the draft. The inference endpoint is `http://127.0.0.1:8787/v1`. A new database starts with an empty draft; the server does not import example credentials or publish a configuration automatically.

`npm run dev:node` runs the TypeScript entry point with file watching. Build the console first with `npm run build:web`; the Node server serves `console/dist`. Existing Cloudflare development commands continue to work.

For an initial JSON configuration:

```bash
npm run config:validate -- config.json
npm run config:import -- config.json
```

Import refuses to overwrite an existing draft. Subsequent edits and publications use the console. Copying configuration with Antigravity account references does not copy its encrypted account state; authorize accounts in the new installation.

Native Node runs migrations at startup by default. D1 uses `migrations/d1/`. Native SQLite reuses those base migrations and adds `migrations/sqlite/`; PostgreSQL uses `migrations/postgres/`. Migration history and schema changes are committed together. PostgreSQL holds a transaction advisory lock on the same connection that applies migrations, including through transaction-mode connection poolers. `DATABASE_MIGRATE=false` disables automatic migrations once the database has been prepared. SQLite files should live on a persistent local volume; use PostgreSQL when scaling across hosts.

To apply migrations separately, run `npm run db:migrate:standard`. This command needs only `DATABASE_URL` (or `DATABASE_MIGRATION_URL` for a separate migration connection/role); it does not require Redis, administrator credentials or the configuration encryption key. The bundled equivalent is `node --env-file=.env dist/migrate.mjs`.

The `dist/` directory contains the Node bundle, console and migrations and can run independently with `node server.mjs`. Supply environment variables from the process environment or an env file. `HOST` defaults to `127.0.0.1`; `PORT` defaults to `8787`. Local administrator mode requires a loopback bind. Use OIDC or Access before binding to `0.0.0.0`.

## Administrator authentication

`ADMIN_AUTH_MODE=local` is for a local Node process only. Vercel rejects it. Cloudflare's separate `ADMIN_LOCAL_DEV` flag is not read by the standard runtime.

For a browser console in production, configure:

```dotenv
ADMIN_AUTH_MODE=oidc
ADMIN_OIDC_ISSUER=https://identity.example.com
ADMIN_OIDC_CLIENT_ID=cody
ADMIN_OIDC_CLIENT_SECRET=your-client-secret
ADMIN_OIDC_ALLOWED_EMAILS=admin@example.com,another-admin@example.com
```

Register `https://your-gateway/console/auth/callback` with the identity provider. Login uses authorization code flow with PKCE and checks the state, nonce, issuer, audience and verified email allowlist. Sessions use encrypted HttpOnly cookies; session lifetime defaults to 12 hours and is configurable with `ADMIN_SESSION_TTL_SECONDS`. The provider must return an `email_verified: true` claim. Public OIDC clients may omit the client secret.

When terminating TLS at a reverse proxy, preserve the gateway's public Host and set `X-Forwarded-Proto: https`. The proxy must overwrite forwarded headers received from clients. Mutations continue to require the same origin and `x-cody-admin: 1`.

`ADMIN_AUTH_MODE=access` accepts Cloudflare Access JWTs with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, for example behind a Cloudflare Tunnel. `ADMIN_AUTH_MODE=token` is for programmatic administration: set `ADMIN_TOKEN` to a random string of at least 16 characters and send `Authorization: Bearer …` or `x-admin-token`. This mode does not provide a browser token-entry screen.

Console assets are public by default; APIs always require administrator authentication. `ADMIN_ASSETS_PUBLIC=false` also protects assets on Node. On Vercel, built static assets are public; use the authenticated Node deployment when private assets are required.

## Vercel

Connect the repository to Vercel with Node.js 24 selected and leave Root Directory empty. The deployment builds from the repository root; choosing the `console` workspace as the Root Directory fails with `Missing script: "build:vercel"`. The checked-in `vercel.json` runs `npm run build:vercel && npm run db:migrate:standard`: it builds the [Build Output API v3](https://vercel.com/docs/build-output-api/v3/configuration) deployment, then applies pending PostgreSQL migrations automatically before Vercel releases it. A failed build or migration stops deployment. The output includes a streaming Node function, console assets and a daily maintenance cron. No Cloudflare bindings are needed.

Set `DATABASE_URL` to an existing PostgreSQL database, `REDIS_URL`, `CONFIG_ENCRYPTION_KEY`, the administrator authentication variables above, and a random `CRON_SECRET` of at least 16 characters. All instances of the same deployment must use the same database, Redis prefix and encryption key. Separate independent installations with separate databases and `REDIS_PREFIX` values.

The deployment build needs a reachable database and schema permissions. It uses `DATABASE_MIGRATION_URL` when set, otherwise `DATABASE_URL`; both come from the target Vercel environment. Applied migrations are skipped, and concurrent PostgreSQL migration runners are serialized with a transaction advisory lock. A separate migration connection lets the function use a database role with data permissions only. Keep each preview environment's database and Redis prefix separate from production.

Vercel request initialization does not apply migrations. Leave `DATABASE_MIGRATE` unset on Vercel; it controls native Node startup only. For local or CI bundle validation, `npm run build:vercel` builds without connecting to a database. When deploying that output with `vercel deploy --prebuilt`, run `npm run db:migrate:standard` with the target database settings before deploying, since prebuilt deployments skip Vercel's build command.

Reuse a PostgreSQL pool per function instance. `DATABASE_POOL_SIZE` defaults to 5; size the total across instances to match your database or use your provider's pooled connection URL. Connection acquisition times out after five seconds. On Vercel, idle PostgreSQL connections expire after five seconds and the pool is registered with `attachDatabasePool`. Redis reuses a connection for concurrent commands, closes it after five seconds idle through `waitUntil`, and reconnects on demand. Active commands are never closed by the idle timer. Place the function, PostgreSQL and Redis in nearby regions to limit coordination latency.

The generated function uses `nodejs24.x`, enables streaming responses and defaults to a 300-second maximum duration. Set the build-time `VERCEL_MAX_DURATION` to a value supported by your plan. HTTP and SSE requests remain subject to [Vercel function limits](https://vercel.com/docs/functions/limitations). Inbound WebSocket is intentionally unsupported on this target.

The daily cron invokes `GET /_cody/maintenance` with Vercel's `Authorization: Bearer <CRON_SECRET>` header. On a plan that supports more frequent cron runs, adjust the schedule in `scripts/build-standard.mjs`. Due object alarms are also processed during request activity. Vercel does not guarantee second-level alarm delivery while idle, so background onboarding, delivery recovery and housekeeping can wait until the next request or scheduled invocation. The cron path rejects unauthenticated requests.

## State and recovery

Configuration revisions, OAuth tokens, health cooldowns, proxy bindings, session ownership and usage journals live in SQL. Sensitive configuration and OAuth payloads use `CONFIG_ENCRYPTION_KEY`; publication and rollback never restore old OAuth tokens. Published configuration is read from the database's published revision and cached per process for `CONFIG_CACHE_TTL_SECONDS` (10 seconds by default).

Redis supplies renewed per-object locks. Owner-checked renewal and SQL revision checks prevent expired lock holders from overwriting newer object state. A Redis outage prevents session/proxy coordination; there is no automatic fallback to an in-memory registry or direct proxy bypass. `MemoryRedis` is a test fixture only.

Usage events are journaled before delivery and ingested idempotently. Node WebSocket usage is journaled before local acknowledgement; interrupted requests are eventually marked incomplete by maintenance. Node runs due alarms every second and reporting maintenance hourly, and drains tracked work on graceful shutdown.

Standard object storage serializes direct operations with transactions, so an asynchronous transaction cannot overwrite a newer direct write. Native WebSocket queues are bounded at 32 MiB and 1,024 pending events per pair endpoint; the network send buffer is also bounded at 32 MiB. An overloaded connection closes with status 1013 so a slow consumer cannot retain an unbounded response backlog.
