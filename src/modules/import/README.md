# import

**Tier 2, isolated.** The one-time import from TimeOff.Management's SQLite file into one company
(`pnpm import:timeoff`, docs/import.md). It is CLI-only: it runs with the database owner's credentials and no
session, so nothing in `src/app` may import it (ESLint refuses `@/modules/import` there).

## Owns

The `import_runs` table (one row per applied import, keyed by the file's SHA-256), and the import's writes to
companies, departments, leave types, holidays, people, allowances, leave requests and the audit log, all in one
transaction. Its queries are in `infrastructure/drizzle-import.repository.ts`; creating the company itself is in
`src/shared/lib/db/company-creation.ts`, which the first install shares.

## Public API (`index.ts`)

- `readTimeOffFile(path)` → `TimeOffSnapshot`: reads the file only. Fails with `import_refused` when it is not a
  TimeOff database.
- `importTimeOff(ctx, input)` → `TimeOffImportReport`: a dry run by default (everything runs, then rolls back);
  with `apply` it commits when every current-year balance matches TimeOff's. Throws `DomainError`
  `import_refused` or `invalid_input`; the CLI prints the message.
- `TIMEOFF_IMPORT_SOURCE`, and the types `TimeOffImportInput`, `TimeOffImportReport`, `ImportCounts`,
  `Reconciliation`, `ReconciliationMismatch`, `ImportIssue`, `TimeOffSnapshot`.

An applied import writes one outbox event, `import.completed`, through `recordChange`; the history it brings in
is audited (`import.*`) but sends no events.

## Inside

- `domain/timeoff/source.ts` (TimeOff's records), `balance.ts` (TimeOff's own day counting and balance), and
  `mapping.ts`, which builds the import plan one entity at a time with the steps in `domain/timeoff/plan/`:
  `company`, `holidays`, `departments`, `people`, `leave-types`, `calendars`, `requests`, `allowances`
  (`types.ts` and `rules.ts` are shared by them).
- `application/import-timeoff.ts`: the use case and its steps in `application/steps/`: `target` (refuse a
  repeated file, find or create the company, plan), `match-people`, `apply-organisation` (settings,
  departments, leave types, holidays), `apply-people`, `apply-leave` (allowances, requests), `reconcile`
  (the rollover's carry and the balance check) and `finish` (report, `import_runs`, the event). Each step's
  mapping from the plan to rows is a pure function with a unit test (`tests/unit/modules/import/`).
- `infrastructure/timeoff-sqlite-reader.ts`: reads the file with `node:sqlite`. It never touches OOOhm's
  database.
