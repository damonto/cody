# AGENTS.md

## Project

Cody is a TypeScript AI API gateway and React web console for OpenAI- and Anthropic-compatible clients. The same application runs on Cloudflare Workers, native Node.js and Vercel. Supported providers are AI Gateway, Antigravity, Codex, Claude and xAI.

## Start here

- Use Node.js **24+** and npm. Run commands from the repository root; install dependencies with `npm ci`.
- Read the relevant guide below before changing that behavior, including its tests. These guides hold the detailed constraints; read only the sections needed for the task.
- Keep changes focused. When changing behavior, update the corresponding schemas, services, adapters, console contracts and tests together as applicable.
- Check nearby code and tests before adding abstractions or compatibility paths. Preserve explicit request/result interfaces and discriminated provider types; prefer narrow dependencies and runtime validation over double type assertions.

## Where to work

- [Configuration](docs/agents/configuration.md): schemas, resource APIs, pricing and migrations in `src/config/`, `src/control/`, `src/admin/`, `src/billing/` and `migrations/`.
- [Gateway](docs/agents/gateway.md): routing, retries, health, sessions, WebSocket, SOCKS5, model lists and search in `src/gateway/`.
- [Providers](docs/agents/providers.md): adapters, OAuth, account selection, quotas and resets in `src/providers/`. Also read the gateway guide for routing changes.
- [Platforms and persistence](docs/agents/platforms.md): entry points in `src/{worker,server,vercel}.ts`, runtime code in `src/platform/`, usage/reporting in `src/telemetry/` and `src/reporting/`, deployment in `scripts/`.
- [Console](docs/agents/console.md): pages, forms, queries and bundles in `console/src/`, browser tests in `console/e2e/`. Also read the affected configuration/provider guide.

`src/app.ts` composes the runtime-neutral Hono application. `src/shared/` contains shared utilities and browser-safe contracts. Use [README.md](README.md) for platform setup and [console/README.md](console/README.md) for console development.

## Commands

| Purpose                                              | Command                                     |
| ---------------------------------------------------- | ------------------------------------------- |
| Worker + console, local development                  | `npm run dev:cloudflare`                    |
| Node + console, local development                    | `npm run dev:node`                          |
| Console only, with a gateway already running         | `npm run dev:console`                       |
| Build console and validate Worker without deployment | `npm run build:cloudflare`                  |
| Build Node / run built Node server                   | `npm run build:node` / `npm run start:node` |
| Generate Vercel Build Output API deployment          | `npm run build:vercel`                      |
| Regenerate Worker binding types                      | `npm run types:cloudflare`                  |

Development uses gateway port `8787` and console port `5173`; run one platform at a time. Node development requires configured SQL, Redis and `.env`; Worker development initializes local state through `scripts/setup-local.mjs`.

Name platform scripts `<action>:cloudflare`, `<action>:node`, `<action>:vercel` and console scripts `<action>:console`. `build:*` must never connect to a database. Deployment and migration commands have side effects; their ordering is documented in the platforms guide.

## Verification

Before handing off changes, run:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build:cloudflare
```

- `npm test` runs Node tests in `tests/*.test.mjs`, builds the console, then runs Worker/admin integration tests in `tests/{worker,admin}/` with Vitest and workerd. It includes configuration/compiler checks and the console bundle budget.
- While iterating, use `node --import tsx --test tests/<name>.test.mjs` or `npm run test:worker -- tests/worker/<name>.test.ts` for a focused check. Add regression coverage for changed routing, validation, aggregation and health behavior.
- For console interaction changes, also run the relevant Playwright cases with `npm run test:e2e -- <name>.spec.ts`; Chromium must be installed. The suite uses intercepted API fixtures.
- Lint rejects warnings. Format checks cover the repository except `.prettierignore` exclusions. Format changed files rather than unrelated files.
- Report checks actually run, failures and any unverified behavior. Do not replace a failed check by weakening it.

## Global constraints

- **SQL is authoritative.** Configuration changes use resource-specific APIs, typed entity services and one fenced transaction. No whole-configuration writes, persisted drafts, manual publish, import/export workflow, file-based configuration or KV configuration distribution. `/config` returns metadata only.
- **Identity is durable.** Generate UUIDs on the server; never derive identity from names. Soft-delete entities and relations so historical references remain valid. No archive browsing or per-entity restoration.
- **Coordination fails closed.** Preserve SQL version checks, stale-write fencing, encrypted OAuth state and durable usage delivery. Standard runtimes require Redis coordination and SQL persistence; never fall back to process-local production state.
- **Preserve the wire contract.** Keep bodies, query strings, application headers and upstream responses intact unless routing or a documented adapter rule requires a change. Strip client credentials, proxy metadata and hop-by-hop headers. All upstream calls go through the provider adapter entry point.
- **Retries are explicit.** Apply only the selected provider's configured policy with the same credential snapshot. No cross-provider fallback after an upstream request starts. Native quota switching is a specific exception described in the providers guide; never replay after downstream output starts.
- **Keep credentials private.** Never commit API keys, OAuth tokens, encryption keys, migration backups, `config.json`, `config.local.json`, `.dev.vars`, `.env*` containing secrets, `.vercel/`, `data/` or local databases. Preserve the deployment's `CONFIG_ENCRYPTION_KEY`; local administrator mode binds only to loopback.
- **Paid actions stay opt-in.** Mock reset credits in tests. Manual Codex reset consumption requires confirmation; automatic consumption and extra usage remain disabled by default. Never enable upstream billing or change spending limits.
- **Preserve deployed history.** Add new migrations for schema changes; never replay applied migrations, recreate retired conversion tools, rename recorded migrations or remove Durable Object migration history. Production accepts only the current config, v2 WebSocket snapshots and v2 usage events.

## Keep these instructions useful

Keep this file a short entry point: common commands, code locations and cross-cutting rules. Put detailed behavior in the relevant linked guide, with code/test pointers. Update the owning section when a rule changes instead of appending a duplicate or a task diary. Keep paths and commands valid. `CLAUDE.md` imports this file; maintain one shared set of instructions.
