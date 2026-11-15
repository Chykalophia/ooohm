# organisation

**Tier 2, CRUD.** How a company is organised. Today it holds levels (Intern, Senior: optional names people are
placed at, so allowance rules can give them more or less time off). Departments, leave types, company settings and
appearance join it in later phases.

## Owns

The `levels` table (`infrastructure/drizzle-levels.repository.ts`). Only this module writes it.

## Public API (`index.ts`)

- `createLevel(ctx, actor, name)` → `ServiceResult<LevelDTO>`: fails with `forbidden`, `invalid_input` or
  `already_exists` (the same name, ignoring case).
- `renameLevel(ctx, actor, id, name)` → `ServiceResult<LevelDTO>`: also `not_found`.
- `deleteLevel(ctx, actor, id)` → `ServiceResult<void>`: also `no_company` and `level_not_empty`. The level's
  allowance rules go with it, each recorded as removed.
- `listLevelsForAdmin(ctx, actor)` → `ServiceResult<LevelSummaryDTO[]>`: the admin screen, with head counts.
- `listLevels(ex, companyId)` and `findLevel(ex, companyId, id)` → `LevelDTO`s: reads for other services (people,
  allowance rules, the audit log), on the executor or transaction they pass. The caller checks the actor.
- `canManageLevels(actor)`: admins only.
- Types `LevelDTO`, `LevelSummaryDTO`.

Every change writes an audit row and an outbox event (`level.created`, `level.renamed`, `level.deleted`) in its
transaction, through `recordAdminChange`.

## Inside

- `application/use-cases/`: `create-level.ts`, `rename-level.ts`, `delete-level.ts`.
- `application/queries/`: `list-levels-for-admin.ts`, `list-levels.ts`, `find-level.ts`.
- `application/policies.ts`, `application/dto.ts`, `application/level-changes.ts` (event payload, unique-name race).
- Level names are checked by `normalizeLevelName` in `src/domain/people.ts`, which departments share.
