# Database and OAuth transfer

`npm run data:transfer` copies Cody's business SQL tables and encrypted OAuth accounts between Cloudflare D1, SQLite, PostgreSQL and libSQL. It accepts fresh targets only; there is no incremental merge or time filter. Node.js and Vercel use their database connection directly.

## Scope

The CLI copies all declared business tables: configuration entities and relationships, soft-deleted records, encrypted secret versions, configuration snapshots, price history, audit/idempotency records, OAuth indexes, requests, attempts and hourly aggregates. UUIDs, timestamps, versions, stored costs and JSON content stay unchanged. Integers remain exact across database engines. Deployment migration records, object coordination tables and the deployment-local SIWC host identity are excluded. A target retains its own host ID; a fresh target generates one on its next SIWC authorization. Transferred SIWC registrations retain their issued client IDs and encrypted token sessions.

The four native providers' encrypted OAuth account records are copied unchanged, including tokens, account identity, generation and any state stored within that ciphertext. Import does not refresh tokens or call providers. Source OAuth alarms are paused and target schedules are enabled only after verification.

Health/cooldown objects, proxy runtime state, reset execution leases, sessions, xAI continuation caches, WebSocket journals, usage outboxes and queue messages are not transferred. The CLI does not inspect queues, recover unrecorded usage or settle unfinished requests. Database records are copied as stored. Deployment domains, administrator authentication, platform credentials and Redis state must be configured separately.

OAuth discovery includes disabled and soft-deleted resources. Extra objects outside the SQL/history inventory are skipped. An OAuth index whose provider no longer exists and whose account has no credential or historical reference is also skipped before accessing its object; the SQL row is preserved. Accounts retained in the inventory must pass decryption and identity checks.

## Prerequisites

- Run Node.js 24+ and install this checkout's dependencies with `npm ci`.
- For either Cloudflare endpoint, install the `sqlite3` command-line tool. It parses Wrangler's SQL export locally, preserving SQL literals and 64-bit integers without a custom SQL parser.
- Use the same Cody release and apply each platform's existing database migrations. Deployments must have the transfer OAuth RPC methods; updating the local checkout does not update deployed Durable Objects.
- Configure the same `CONFIG_ENCRYPTION_KEY` on both deployments and the CLI. OAuth ciphertext and encrypted database secrets are not rotated.
- Use a fresh target. Only initialization metadata and the untouched four native provider seeds are allowed. Those seeds are replaced with the source identities.

Stop requests, console writes, OAuth flows, cron jobs and other background writers on both sides, then wait for in-flight work. Stop standard servers and Vercel invocations. On Cloudflare, stop public traffic and background producers/consumers while leaving the Worker and its object bindings accessible to the CLI. Keep the source stopped after success.

The CLI asks you to confirm this maintenance window; `--yes` confirms it without prompting. It adds no runtime maintenance lock or SQL migration. D1 export/import blocks database access, so it runs only after confirmation. Concurrent application writes invalidate the transfer's consistency assumptions.

## Connections

Connection secrets come from environment variables. The npm command loads `.env` when present. Replace `SOURCE` with `TARGET` for the destination:

| Variable                       | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `SOURCE_DATABASE_URL`          | `sqlite:`, `postgres://` / `postgresql://`, or `libsql://` URL              |
| `SOURCE_CONFIG_ENCRYPTION_KEY` | Deployment's base64 32-byte key; defaults to shared `CONFIG_ENCRYPTION_KEY` |
| `SOURCE_CLOUDFLARE_API_TOKEN`  | Optional override; otherwise use Wrangler authentication                    |
| `SOURCE_CLOUDFLARE_ACCOUNT_ID` | Optional override; otherwise use Wrangler account/config discovery          |
| `SOURCE_CLOUDFLARE_WORKER`     | Optional override; otherwise use the selected Wrangler Worker name          |

SQLite files must exist and be migrated. PostgreSQL URLs must explicitly name the database. Use your deployment's TLS settings for remote SQL connections. Vercel supports PostgreSQL and libSQL, not SQLite. No Redis connection is needed for transfer.

Cloudflare defaults to Wrangler login and project configuration. Run `npx wrangler login` if needed. The CLI captures `wrangler auth token --json` in memory without printing credentials or reading private auth files. Standard Wrangler environment credentials work too. For multiple accounts, set `account_id` or an explicit account override. Select projects/environments with `--from-config`, `--to-config`, `--from-env` and `--to-env`.

Cloudflare credentials need Worker settings, D1 export/import, OAuth Durable Object enumeration and remote preview access. No Queues permissions or HTTP pull consumers are needed. A temporary authenticated preview performs preflight and typed OAuth RPC; it rejects SQL table paging and arbitrary SQL. It adds no permanent route. Cloudflare connections use HTTPS; Wrangler's local listener binds to loopback.

## Database transport

For a D1 source, the CLI runs Wrangler's native equivalent of:

```bash
npx wrangler d1 export <database> --remote --output=<temporary.sql>
```

The dump is loaded into temporary SQLite and opened for read-only transfer operations. Table reads and verification use that local database instead of making remote requests for small pages. PostgreSQL, SQLite and libSQL exchange up to 1,000 rows per page, bounded by payload size, and insert rows in multi-row statements. Replay checks query a page once rather than each row individually. Historical snapshot references to secrets, OAuth accounts and price versions are checked in batches; missing references stop the transfer before target scheduling begins. SQLite/D1 foreign keys are checked explicitly, and encrypted database secrets must decrypt to credential strings.

For a D1 target, the CLI streams a data-only SQL file and runs:

```bash
npx wrangler d1 execute <database> --remote --file=<temporary.sql> --yes
```

Only business tables are replaced, in foreign-key order. Target migrations/schema and OAuth objects are kept separate. Requests/attempts are imported before source hourly totals replace trigger-generated aggregates, including historical hours without retained request details. The final D1 database is exported once for local content verification. Generated statements respect D1's statement size limit; a single row too large for native SQL import stops before the import command runs.

Temporary SQL/SQLite files live in a private directory and are removed on normal exit, including failures. A forced kill can leave a `cody-transfer-db-*` directory in the operating system's temporary directory; it can be removed after the process stops. These files can contain sensitive business data. Never commit backups or credentials.

## Run, resume and abort

Check schema, keys, access and target emptiness:

```bash
npm run data:transfer -- --from cloudflare --to postgres --dry-run
```

Preflight does not export/import the database, change alarms or create a task file. It cannot prove all write permissions without attempting a write. After stopping both deployments, start a new task:

```bash
npm run data:transfer -- --from cloudflare --to postgres
# Reverse direction:
npm run data:transfer -- --from postgres --to cloudflare
```

The CLI prints a UUID and its `.cody-transfer/<UUID>.json` journal. `--state-dir` selects another directory. The journal uses restricted permissions and atomic writes; it contains identities, digests, cursors and schedules, not rows or tokens. This simplified workflow uses a new journal format. Old task files are not continued; start with a fresh target.

If a new task is interrupted, leave both deployments stopped and resume it:

```bash
npm run data:transfer -- --from cloudflare --to postgres --resume TASK_UUID
```

Standard SQL batches and OAuth writes compare committed content before replay. A native D1 import saves its complete file digest before writing; resume regenerates the file, checks the digest and reruns the replacement import if needed. This covers an import that committed but lost its acknowledgement. Changed content stops the task. Do not edit the source or partial target during a task. Password/token rotation is allowed as long as database identities and encryption keys stay the same.

Before target activation, an abort restores saved source OAuth schedules:

```bash
npm run data:transfer -- --from cloudflare --to postgres --abort TASK_UUID
```

An interrupted abort must finish with `--abort`. Discard the incomplete target. After target scheduling starts, abort is refused because target token refreshes may have invalidated source credentials. Keep the old source stopped and resume activation instead.

## Cutover and validation

After successful table/OAuth content verification, start the target and switch traffic through your deployment setup. Keep the source stopped. Retain the journal until cutover is complete; a reverse migration is a new task into another fresh target.

Tests exercise SQLite, PostgreSQL and libSQL, native SQLite parsing of mocked Wrangler exports/imports, D1/OAuth RPC, retained rollups, integer precision, bulk query counts, interrupted batches and lost import acknowledgements. Provider/upstream operations are mocked. Run preflight and a staging transfer to validate your actual Cloudflare credentials and deployment procedures.
