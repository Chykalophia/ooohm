# OOOhm: notes for coding agents

OOOhm (Out Of Office, Holiday Manager) is a leave tracker for small teams. The v1 scope lives in the
"OOOhm — v1 Scope" doc, and the work is tracked in ClickUp (Internal Projects → OOOhm, tasks M0–M7).
Work one milestone at a time and keep each PR to a single milestone.

## Product rules (don't break these)

- **The UI stays calm.** Use one accent color (teal in the default Classic theme), keep whitespace generous, and keep each screen to one main action. If a screen needs explaining, it's wrong.
- **Themes are company-wide; light or dark is per person.** An admin picks the theme, an optional accent color and the corner style (Admin → Appearance); people can't override it. Each person picks a colour mode (light, dark, automatic), which applies where the theme has a dark version (Classic, for now). Style screens with the theme tokens (`bg-accent`, `text-accent-ink`, `bg-surface`, `border-border`, …), never fixed brand colors, so every theme works. Use `text-accent-ink`, not `text-accent`, for accent-colored text.
- **Access is invite-only.** Neither magic links nor Google sign-in may create users. Admins (or the seed) create them.
- **The allowance policy is pluggable.** v1 ships only `annual_calendar_year`: a flat yearly allowance per leave type that resets Jan 1. Carryover is set per leave type and is OFF by default.
- **Approvals:** one approver (the manager) per person. `user.can_self_approve` auto-approves that user's own requests.
- **Integrations go through `events_outbox`.** Write a domain event in the same transaction as every state change. No adapters ship in v1.
- **Audit everything.** Every request decision and every balance change writes an `audit_log` row, naming who or what made it (a person, a person through a sync or import, their API key, or a system process). Nothing is anonymous.
- **Day counts are numeric with one decimal place** (half days = 0.5). Weekends and company holidays never count.

## Stack and commands

Next.js 16 (App Router, `output: "standalone"`, Cache Components **off**), TypeScript, Postgres + Drizzle,
Better Auth (magic link + optional Google), Tailwind v4, pnpm. Runs on any Postgres 15+ or embedded PGlite, with Docker,
on Vercel, or on one machine (docs/hosting.md): never assume a host.

```bash
pnpm dev            # local dev (needs Postgres + .env)
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm db:generate    # after editing src/db/schema.ts — commit the generated SQL in drizzle/
pnpm db:migrate
pnpm db:seed        # idempotent; uses SEED_ADMIN_EMAIL
pnpm job:rollover   # idempotent year rollover (carryover + new-year allowances)
pnpm worker         # outbox worker: webhooks, adapter deliveries, daily rollover + retention
pnpm import:timeoff -- --file <x.sqlite> --company <id> --actor <admin email> [--apply]   # one-time TimeOff import (dry run by default)
pnpm test           # unit tests (no database)
pnpm test:integration  # service tests; set TEST_DATABASE_URL (see docs/architecture.md#testing)
pnpm test:integration:embedded  # the same on embedded PGlite (no server); keep both green
pnpm start:embedded # after pnpm build: migrate, seed and serve on embedded PGlite (docs/hosting.md)
docker compose up   # full stack: db, migrate+seed, app, mailpit (http://localhost:8025)
```

## Layout

Layered; dependencies point downward only. Full rules in `docs/architecture.md`.

- `src/app/**`: presentation. Thin pages and server actions. Signed-in pages open with `requireMemberPage()` / `requireAdminPage()` and render inside `AppPage` / `AdminShell` (sign-in and route handlers are the exceptions; the API has its own entry below); actions are a zod schema and one service call through `runFormAction` / `runStateAction`, or `runActionThenGo` to redirect after (`src/app/_lib/server-action.ts`). No Drizzle here. Route-specific components sit beside their route.
- `src/app/_lib/**`: the presentation layer's helpers: page loaders (`page-context.ts`), the server action pipeline (`action-pipeline.ts`, wired in `server-action.ts`), shared form field schemas, `runActionWith` messages, input schemas, the app's background tick.
- `src/components/**`: shared UI, by kind (`ui`, `forms`, `layout`, `navigation`, `leave`). Components render props; they never load data or import `src/app` or `src/server` (lint enforces it). Style controls with the recipes in `src/components/ui/styles.ts`, not new Tailwind strings. Colours are theme tokens from `src/app/globals.css` (light and dark in one `light-dark()` value); lint refuses palette classes and `dark:`. Lists that grow with use are paged with `readPage` + `Pager`, never capped. See docs/architecture.md#presentation.
- `src/app/admin/**`: the admin screens. Pages start with `requireAdminPage()` (404 for non-admins) and render in `AdminShell`; actions go through `adminAction()`. The services check the role again (`assertCanAdminister`), so never rely on the page alone.
- `src/server/services/**`: use cases. Own transactions, data-dependent authorization, `recordLeaveChange`/`recordChange` for every state change, and email via `commitThenNotify` / `commitThenSend` (after commit, never throws). Admin use cases are `admin-*.ts` plus `audit-log.ts`; they record changes with `recordAdminChange` and take `lockCompany` first when a rule spans several people.
- `src/server/repositories/**`: Drizzle queries only; each takes an executor (`db` or `tx`) first.
- `src/server/integrations/**`: the adapter seam (`Adapter`, `adapterRegistry`); `installed.ts` lists adapters (none in v1). No database access: services write what adapters return.
- `src/server/importers/**`: source readers for one-time imports (TimeOff's SQLite file → `src/domain/timeoff` records). Read files only; `timeoff-import.ts` (service) owns the transaction. See `docs/import.md`.
- `deploy/`: the production compose file, Caddyfile, backup/restore scripts and systemd timer. Runbook: `docs/deploy.md`.
- `src/app/api/v1/**`: the REST API. Routes are one line through `_lib/api-get.ts` → `_lib/handler.ts` (auth, rate limits, errors); keep `_lib/openapi.ts` in sync (a test checks).
- `src/domain/**`: pure rules (approval rule, day counting, status machine, permissions, `DomainError`). No I/O, Next, Drizzle or env.
- `src/server/context.ts` / `src/server/runtime.ts`: the injected `ServiceContext` type and the app's composition root.
- `src/db/config.ts` / `src/db/connect.ts`: the one place a database is chosen and opened (Postgres with pooler detection, or embedded PGlite with its directory lock). Scripts, the worker and tests open it there too. Raw `execute()` results differ by driver: use the query builder, or `executeRows` (`src/db/rows.ts`).
- `src/db/schema.ts`: every table. Better Auth's tables (`user`, `session`, `account`, `verification`) live here too.
- `src/lib/auth.ts`: Better Auth config, `issueSignInLink()` (invite links, wired into `ServiceContext`), `requireUser()` and `requireActor()`, the entry points for pages and actions (`currentUser()` for route handlers, which answer 401 instead of redirecting).
- `src/lib/env.ts`: validated env vars. Add new ones here, in `.env.example`, and in `docker-compose.yml`. Values are trimmed on read.
- Background work is one function, `runTick` (`src/server/services/background-tick.ts`), run by the worker, `/api/cron/tick`, the inline after-change tick (`ctx.wake`, via the `inTransaction` / `commitThenSend` seam in `notify.ts`) or embedded mode's timer (`src/instrumentation-node.ts`). A service that records changes opens its transaction with `inTransaction(ctx, ...)` (or `commitThenSend`), never `ctx.db.transaction`, so inline mode sees its events.
- `scripts/*.mts`: migrate, seed and the year rollover (`pnpm job:rollover`), run in that order by the `migrate` compose service; and the outbox worker (`pnpm worker`, the `worker` service), which delivers webhooks and runs the daily jobs. The worker reads `src/lib/worker-env.ts`, never `env.ts`. `import-timeoff.mts` is the one-time TimeOff importer.
- `docs/api.md`: the public integration reference (auth, endpoints, events and payloads, webhooks, signatures). Update it with any event or API change.
- `tests/unit/**` (`pnpm test`) and `tests/integration/**` (`pnpm test:integration`, needs `TEST_DATABASE_URL`; fresh database per file). Both run under `--conditions=react-server` so `server-only` modules load.

## License

Source-available, under FSL-1.1-ALv2 (see LICENSE.md). Never describe the project as "open source."

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
