# Cody Console

The `@cody/console` workspace was bootstrapped with the official Vite React + TypeScript template.

React + TypeScript, Vite, Tailwind CSS, official shadcn/ui Radix components, Zod, TanStack Form/Query/Table, and Recharts. The interface is English-only. Application code lives in `src/pages` and `src/components`; generated shadcn components are under `src/components/ui`.

Use the repository root scripts so the gateway, queue consumer, and admin API run together. See [the project README](../README.md) for local setup, deployment, and verification.

```bash
npm run dev:setup
npm run dev
# Optional Vite hot reload in another terminal:
npm run dev:web
```

Configuration edits save a versioned draft. Publishing is explicit. Draft conflicts keep the editor open. Secrets returned by the API are masked; an unchanged credential keeps its saved value.

The Playwright suite uses intercepted API fixtures. Run `npm run test:e2e` from the repository root after installing Chromium.
