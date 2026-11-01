# OOOhm: notes for coding agents

OOOhm (Out Of Office, Holiday Manager) is a leave tracker for small teams. The v1 scope lives in the
"OOOhm — v1 Scope" doc, and the work is tracked in ClickUp (Internal Projects → OOOhm, tasks M0–M7).
Work one milestone at a time and keep each PR to a single milestone.

## Product rules (don't break these)

- **The UI stays calm.** Use one accent color (teal), keep whitespace generous, and keep each screen to one main action. If a screen needs explaining, it's wrong.
- **Access is invite-only.** Neither magic links nor Google sign-in may create users. Admins (or the seed) create them.
- **The allowance policy is pluggable.** v1 ships only `annual_calendar_year`: a flat yearly allowance per leave type that resets Jan 1. Carryover is set per leave type and is OFF by default.
- **Approvals:** one approver (the manager) per person. `user.can_self_approve` auto-approves that user's own requests.
- **Integrations go through `events_outbox`.** Write a domain event in the same transaction as every state change. No adapters ship in v1.
- **Audit everything.** Every request decision and every balance change writes an `audit_log` row.
- **Day counts are numeric with one decimal place** (half days = 0.5). Weekends and company holidays never count.

## Stack and commands

Next.js 16 (App Router, `output: "standalone"`, Cache Components **off**), TypeScript, Postgres + Drizzle,
Better Auth (magic link + optional Google), Tailwind v4, pnpm.

```bash
pnpm dev            # local dev (needs Postgres + .env)
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm db:generate    # after editing src/db/schema.ts — commit the generated SQL in drizzle/
pnpm db:migrate
pnpm db:seed        # idempotent; uses SEED_ADMIN_EMAIL
pnpm job:rollover   # idempotent year rollover (carryover + new-year allowances)
pnpm test           # unit tests (no database)
pnpm test:integration  # service tests; set TEST_DATABASE_URL (see docs/architecture.md#testing)
docker compose up   # full stack: db, migrate+seed, app, mailpit (http://localhost:8025)
```

## Layout

Layered; dependencies point downward only. Full rules in `docs/architecture.md`.

- `src/app/**`: presentation. Thin pages and server actions: zod-parse, `requireActor()`, call one service, map the result. No Drizzle here.
- `src/server/services/**`: use cases. Own transactions, data-dependent authorization, `recordLeaveChange`/`recordChange` for every state change, and email via `commitThenNotify` (after commit, never throws).
- `src/server/repositories/**`: Drizzle queries only; each takes an executor (`db` or `tx`) first.
- `src/domain/**`: pure rules (approval rule, day counting, status machine, permissions, `DomainError`). No I/O, Next, Drizzle or env.
- `src/server/context.ts` / `src/server/runtime.ts`: the injected `ServiceContext` type and the app's composition root.
- `src/db/schema.ts`: every table. Better Auth's tables (`user`, `session`, `account`, `verification`) live here too.
- `src/lib/auth.ts`: Better Auth config, `requireUser()` and `requireActor()`, the entry points for pages and actions (`currentUser()` for route handlers, which answer 401 instead of redirecting).
- `src/lib/env.ts`: validated env vars. Add new ones here, in `.env.example`, and in `docker-compose.yml`.
- `scripts/*.mts`: migrate, seed and the year rollover (`pnpm job:rollover`), run in that order by the `migrate` compose service.
- `tests/unit/**` (`pnpm test`) and `tests/integration/**` (`pnpm test:integration`, needs `TEST_DATABASE_URL`; fresh database per file). Both run under `--conditions=react-server` so `server-only` modules load.

## License

Source-available, under FSL-1.1-ALv2 (see LICENSE.md). Never describe the project as "open source."

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
