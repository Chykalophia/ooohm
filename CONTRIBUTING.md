# Contributing to OOOhm

Thanks for helping. OOOhm is a small, calm leave tracker for small teams, and we
want to keep it that way: please read this before you open a pull request.

## Before you start

- **Sign the CLA.** Every contributor signs the
  [Contributor License Agreement](CLA.md) once. When you open your first pull
  request, the CLA Assistant bot comments with a link; click it, sign in to
  GitHub and accept. We can't merge a pull request until everyone who has
  commits in it has signed.
- **Security problems go through private reporting,** never a public issue or
  pull request. See [SECURITY.md](SECURITY.md).
- **Open an issue first for anything bigger than a bug fix,** so we can agree on
  the approach before you spend time on it. The v1 scope is deliberately small:
  accrual, multi-level approvals, multi-company hosting and mobile apps are out.

## License

OOOhm is **source-available** under the Functional Source License (FSL-1.1-ALv2,
see [LICENSE.md](LICENSE.md)). Please describe it as "source-available" or
"Fair Source", never as "open source".

## Setting up

The [README](README.md#run-it) covers running OOOhm with Docker or `pnpm dev`, and
[docs/architecture.md](docs/architecture.md) explains how the code is organized.
You need Node 22 or later, pnpm 10 and Docker (for Postgres and Mailpit).

## Product rules

These hold for every change. [AGENTS.md](AGENTS.md) has the full list.

1. **The UI stays calm:** one accent color (teal), generous whitespace, one main
   action per screen.
2. **Access is invite-only:** no sign-in path may create a user.
3. **Every state change writes an audit log row and a domain event** in the same
   transaction, naming who or what made the change.
4. **Day counts have one decimal place,** and weekends and company holidays never
   count.

## Code

- Keep the layers: `src/app` (thin pages and actions) calls `src/server/services`,
  which calls `src/server/repositories`. Pure rules live in `src/domain`.
- No `console.*` in server code: use `log` from `@/lib/log`.
- Never edit a committed migration. Change `src/db/schema.ts`, run
  `pnpm db:generate` and commit the new SQL.
- Changes to events or the REST API also update [docs/api.md](docs/api.md).
- Write docblocks where they add information; skip comments that restate the code.

## Before you open a pull request

Run these and make sure they pass:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration            # needs TEST_DATABASE_URL, see docs/architecture.md#testing
pnpm test:integration:embedded   # the same suites on embedded Postgres
pnpm build
```

Then:

1. Keep a pull request to one change, with tests that check what the code does.
2. Describe what changed, why, and how you checked it.
3. Expect automated review comments. Fix the real findings, or reply on the
   thread with why you didn't.
