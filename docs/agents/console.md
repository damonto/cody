# Console

Read this guide for `console/` changes. Start with `console/src/App.tsx`, `console/src/pages/`, `console/src/features/`, `console/src/lib/resources.ts` and `console/src/lib/use-resource-editor.ts`. Read the relevant [configuration](configuration.md) or [provider](providers.md) rules when changing their UI.

## Components and bundles

- The UI is English-only. Use the existing React, Vite, Tailwind, shadcn/Radix and TanStack patterns described in `console/README.md`.
- Preserve standard components and exports in `console/src/components/ui/`, even without current callers.
- Keep routes lazy-loaded and shared browser contracts independent of feature schemas. Do not pull reporting libraries into the entry or non-reporting routes, or server OAuth registration/tokenizer code into browser bundles.
- `tests/console-bundle.test.mjs` enforces a 500 kB minified JavaScript chunk budget and feature boundaries. Fix imports rather than raising the limit.

## Resource forms

- Query resource endpoints independently and invalidate only affected resources. Later writes must not mark an invalidated cached resource fresh before it refetches. The shell reads `/config` metadata only. No whole-config writes, import/export, persisted drafts, manual publish, archive browser or per-entity restore controls.
- Preserve editor baselines across background refreshes. Keep loaded forms visible on refresh failure, and keep conflicts/failed mutations open and retryable. Resource fingerprints must detect masked secret changes; unchanged masked credentials retain their saved value.
- Give editable rows stable identities independent of array index and editable names. The server generates durable IDs; strip form-only metadata before saving and keep IDs out of the UI.
- Save settings and account edits independently, taking effect immediately. Unsaved incomplete forms must not prune committed proxy bindings.

## Native provider pages

- The Providers submenu contains only AI Gateway, Antigravity, Codex, Claude and xAI. Native providers are fixed singletons, disabled by default; expose neither creation nor deletion.
- Native pages manage authorization, accounts and quotas directly. Top-right Settings dialogs own enabled state, priority, proxy, models, routes, retries and applicable account-selection/usage options. Antigravity/Codex selection and Codex automatic resets belong in those dialogs.
- Antigravity Gemini selectors group low/medium/high variants under one family with expandable level checkboxes. Save only selected physical IDs, never auto-select newly discovered levels. Use canonical model IDs unchanged in pricing, route selectors, provider counts and badges; remove thinking-level suffixes through family grouping without title-casing or replacing hyphens. Pricing presents one family form; saves atomically apply rates/context to all enabled levels. Quota and cooldown cards use one family heading with separate level details, never summed quotas. Report filters/rankings use logical families; request details retain a separate thinking level.
- Native account lists share the card grid and footer in `features/oauth-accounts/`. Keep common actions consistent (`Refresh`, `Refresh all`, `Manage`); compose provider-specific actions such as Codex resets into the shared footer.
- Native pages compose their account lists and forms through `features/oauth-accounts/native-provider-page.tsx`, which owns editor snapshots and resource mutations. Account toggles update one credential; the ordering endpoint accepts IDs only. Keep Hooks call/dependency checks enabled in the root lint configuration.
- Codex account cards show plan/subscription days, quota windows, credits, reset credits and cooldown state, following CPA-Manager-Plus. Spending a reset always asks for confirmation.
- Claude and xAI extra usage remains opt-in. xAI owns device authorization, quotas and independent settings; do not expose unsupported provider capabilities.

Use form unit tests in `tests/*-form.test.mjs` and the relevant `console/e2e/` Playwright cases for interaction changes. Run browser tests from the repository root with `npm run test:e2e -- <name>.spec.ts`; fixtures intercept the resource APIs.
