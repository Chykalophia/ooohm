# ADR-0003: ServiceResult at the use-case boundary, migrating from thrown DomainError

- **Status:** Accepted (2026-11-14, with the plan in PR #102)
- **Date:** 2026-11-15

## Context

The reference says use cases return `ServiceResult<DTO>` and only unexpected failures throw. OOOhm throws
`DomainError` with a stable `code` and structured `details` (198 throws in services, 79 in the domain); the action
pipeline (`src/app/_lib/run-action.ts`) and the API handler map codes to calm messages and HTTP statuses. The codes
and mappings are good and are a public contract for messages.

## Decision

- We will add `ServiceResult<T> = { ok: true; value: T } | { ok: false; error: AppError }` in
  `src/shared/lib/result.ts`, where `AppError` keeps today's `DomainErrorCode`, message and `details`.
- Use cases in `src/modules/**` return `ServiceResult`. Domain functions in Tier 3 modules return `Result` values;
  Tier 2 domain helpers may keep throwing `DomainError`, which the use case converts with `fromDomainError`.
- During the migration the pipeline and API handler accept both a returned `err` and a thrown `DomainError`, mapping
  them identically (a unit test pins this). The throw path is removed in A8.
- **Results and transactions.** `inTransaction` commits whenever its callback resolves, so an `err` must never be
  returned from inside a callback that has already written. Inside a unit of work, an expected failure is thrown as a
  `DomainError` so the transaction rolls back; the use case catches it **after** the transaction settles and returns
  `err` (`fromDomainError`). A use case may return `err` directly only before it opens the transaction or after it
  settles. A unit test pins this: a use case that writes, then fails, leaves no row and returns `err`.
- We will not adopt `neverthrow` or Effect now; a later ADR may.

## Consequences

- Expected failures become visible in signatures; nobody can forget to handle `insufficient_balance`.
- Messages, codes and HTTP statuses do not change, so the UI and the API do not change.
- Slightly more verbose use-case code (`if (!r.ok) return r`).
