# audit

**Tier 2, query module.** The read-only audit log viewer (Admin → Audit log): who changed what, and when.

## Owns

Reads of the `audit_log` table (`infrastructure/drizzle-audit-log.repository.ts`). It writes nothing: every writer
records its own audit row and outbox event with `recordChange` (`src/shared/lib/db/change-log.ts`), or
`recordAdminChange` (`src/shared/lib/admin-access.ts`), in the transaction of its change (ADR-0010).

## Public API (`index.ts`)

- `getAuditLog(ctx, actor, filter)` → `ServiceResult<AuditLogDTO>`: one page, newest (or oldest) first, with the
  filters in force and the pickers' people and actions. Fails with `forbidden` or `no_company`. Malformed filters
  are ignored, not refused.
- `listAuditEntriesAbout(ctx, actor, subjectUserId, max)` → `AuditLogEntryDTO[]`: every entry about one person, for
  their records export. It runs inside the people module's flow, so it throws a `DomainError` (`forbidden`,
  `no_company`) instead of returning a result.
- `countRecentActions(ex, where, minutes)` → `number`: the invite and import rate limits, on their transaction. The
  caller checks the actor.
- `canViewAuditLog(actor)`: admins only.
- `AUDIT_PAGE_SIZES`, `AUDIT_PAGE_SIZE`, `AUDIT_SEARCH_MAX_LENGTH` and the types `AuditLogFilter`, `AuditPageSize`,
  `AuditLogDTO`, `AuditLogEntryDTO`.

## Inside

- `application/queries/`: `get-audit-log.ts`, `list-audit-entries-about.ts`, `count-recent-actions.ts`.
- `application/audit-reading.ts`: naming the ids in a row, matching a search, reading the filters.
- `application/dto.ts` (`toAuditLogEntryDTO`: labels in, emails and key ids left behind), `policies.ts`,
  `schemas.ts`.
- Action labels and change descriptions come from `src/domain/audit.ts`; who made a change from
  `src/domain/change-source.ts`.
