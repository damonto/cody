# Platforms and persistence

Read this guide for runtime entry points, deployment, SQL/Redis coordination, reporting or usage delivery. Read [Configuration](configuration.md) before changing schema or configuration persistence.

## Runtime boundaries

| Platform   | Entry           | Durable state                | Coordination    | Inbound WebSocket |
| ---------- | --------------- | ---------------------------- | --------------- | ----------------- |
| Cloudflare | `src/worker.ts` | D1 + Durable Objects         | Durable Objects | Yes               |
| Node.js    | `src/server.ts` | SQLite, PostgreSQL or libSQL | Redis           | Yes               |
| Vercel     | `src/vercel.ts` | PostgreSQL or libSQL         | Redis           | No                |

- Keep the shared Hono application in `src/app.ts` runtime-neutral. Keep Cloudflare dependencies in Worker entry/object shells; derive binding types from generated `Env` through `src/platform/bindings.ts` and use narrow dependency types.
- Standard runtime implementations live in `src/platform/standard/`. Require Redis coordination and SQL durable state; never substitute in-memory production state. libSQL uses native-free `@libsql/client/http`.
- Preserve atomic migrations, SQL stale-write fencing, encrypted OAuth state and durable usage delivery. Reuse connection pools, bound connection waits, and retain idle cleanup with the platform's `waitUntil`.
- Local administrator mode must bind only to loopback. Keep Node and Vercel authentication checks in the standard runtime; Vercel does not support SQLite or inbound WebSocket.

## Cloudflare HTTP execution

Code: `src/platform/cloudflare/http-dispatch.ts`, `src/platform/cloudflare/http-execution.ts`; tests: `tests/worker/http-execution.test.ts`.

- Registered HTTP inference/context-management requests execute in one `HttpExecution` object per request. The entry Worker forwards streams without parsing bodies; authentication, routing, adapters and usage observation run inside the executor. WebSocket upgrades retain their separate path.
- Each executor accepts one request. A failed dispatch cancels that executor without resending inference: the upstream may already have started.
- Client disconnects cancel through a separate RPC, including before upstream headers and during blocked response writes. Complete pending usage-journal writes before cancellation finishes.
- Do not persist request bodies or tokens in the executor's own storage. Preserve the existing account, health and session objects for coordination.

## Builds, deployment and migrations

- `build:cloudflare` builds the console and runs `wrangler deploy --dry-run`; it does not deploy. `build:node` and `build:vercel` bundle code/assets without connecting to SQL. Vercel output lives in `.vercel/output/`.
- `deploy:cloudflare` builds the console and applies pending D1 migrations before deploying. Configure target account KV/D1 bindings in `wrangler.jsonc`. Use Workers Builds Git integration from `main` for automatic deployment; do not add a GitHub Actions deployment workflow unless requested.
- `deploy:node` and `deploy:vercel` build, then run `npm run db:migrate`. `vercel.json` uses `deploy:vercel` as its build command, so migration failure blocks deployment. Never run migrations in Vercel request handling.
- PostgreSQL migration locks and writes share one transaction/connection. D1 uses `migrations/d1/`; SQLite/libSQL reuse those files plus `migrations/sqlite/`; PostgreSQL uses `migrations/postgres/`.
- Preserve all recorded Durable Object migrations and stable object addresses in `wrangler.jsonc`: notably the v7 `ServiceHealth` → `ProviderHealth` rename, v8 proxies, v9 OAuth accounts, v10 HTTP execution and v11 retired publisher deletion. Retaining history does not mean restoring the publisher architecture.
- `CODY_CONFIG_KV` contains public provider metadata only, never authoritative configuration or OAuth state.

## Usage and reporting

Start with `src/telemetry/`, `src/reporting/`, `src/platform/standard/usage.ts` and `src/maintenance.ts`.

- Production consumes v2 usage events only. Preserve durable delivery, retry/outbox behavior and metering identities from compiled price versions.
- `npm run reporting:transfer` copies finished requests between D1 and standard databases with `ON CONFLICT DO NOTHING`; target rollup triggers recount them. Settled rollups whose requests were removed by retention become one-time adjustments.
- Read live D1 with queries, never `d1 export`, which blocks the database. Do not commit transfer/migration backups or local database files.

Regression starting points: `tests/standard-*.test.mjs`, `tests/sql-dialects.test.mjs`, `tests/deploy.test.mjs`, `tests/reporting-transfer.test.mjs`, `tests/worker/usage-outbox.test.ts` and the Worker HTTP execution tests.
