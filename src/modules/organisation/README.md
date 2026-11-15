# organisation

**Tier 2, CRUD.** How a company is organised: its settings (name, time zone, working days, allowance policy,
approval mode, what people see of each other) and appearance (theme, accent, corners, request style, layout, logo),
its departments, its levels and its leave type catalog.

Nearly every other module reads organisation, so it imports no other module and none of the old services
(`tests/architecture/organisation-boundary.test.ts`). A change that reaches into another module is exported as a
step on the caller's transaction, and the caller does the rest (see "Steps").

## Owns

- `companies` (`infrastructure/drizzle-companies.repository.ts`; the select shape is shared with the setup and import
  code in `src/shared/lib/db/company-columns.ts`, and the row locks are `src/shared/lib/db/company-lock.ts`).
- `departments` (`drizzle-departments.repository.ts`), `levels` (`drizzle-levels.repository.ts`) and `leave_types`
  (`drizzle-leave-types.repository.ts`).
- One write to `allowance_rules`, which the balance code owns otherwise: deleting a department or level removes its
  rules, each recorded as removed (`application/allowance-rule-removal.ts`). The rule use cases record their own
  changes with the same `allowanceRuleSnapshot` and `allowanceRulePayload`.

Every change writes an audit row and an outbox event (`company.updated`, `department.*`, `level.*`, `leave_type.*`)
in its transaction, through `recordAdminChange`, and nothing when a save changes nothing.

## Public API (`index.ts`)

Use cases and admin queries take `(ctx, actor, …)` and return a `ServiceResult`; each fails with `forbidden` for a
non-admin (the policies below), and its doc comment lists the other codes.

- Company: `getCompanySettings` (the Company and Appearance screens), `updateCompanyAppearance`,
  `updateCompanyLogo`, `removeCompanyLogo` → `CompanyDTO`. `getAppearance`, `getCompanyLogo`, `getDeploymentLogo`
  and `getLogoFile` never fail: the root layout, the header and the sign-in page read them before anyone is known.
- Departments: `listDepartmentsForAdmin` → `DepartmentSummaryDTO[]`, `listDepartmentManagerChoices`,
  `createDepartment`, `renameDepartment`, `setDepartmentLimit` → `DepartmentDTO`, `deleteDepartment`.
- Levels: `listLevelsForAdmin`, `createLevel`, `renameLevel`, `deleteLevel`.
- Leave types: `listLeaveTypesForAdmin`, `getLeaveTypeForAdmin`, `createLeaveType`, `updateLeaveType`,
  `setLeaveTypeArchived` → `LeaveTypeSettingsDTO`, `reorderLeaveTypes` → whether anything moved.
- Policies: `canManageCompanySettings`, `canManageAppearance`, `canManageDepartments`, `canManageLevels`,
  `canManageLeaveTypes` (admins only).

### Reads for other modules

On the executor the caller passes (so a caller inside a transaction reads what it sees); the caller checks the
actor. `findCompany` → `CompanyDTO`; `listDepartments`, `findDepartment` → `DepartmentDTO`;
`findDepartmentLimits`, `findDepartmentManagerIds`, `listManagedDepartmentIds`; `listLevels`, `findLevel` →
`LevelDTO`; `findLeaveType` → `LeaveTypeDTO` (names and colour only); `listAllLeaveTypes`, `findLeaveTypeForAdmin`,
`findLeaveTypeByCode` → `LeaveTypeSettingsDTO`.

`LeaveTypeSettingsDTO.defaultAllowanceDays` is the type's own setting. A person's default can differ (an allowance
rule replaces it), so balances read it only through `loadAllowanceDefaults`; the settings the allowance policy
computes from are read by the balance code itself (`src/shared/lib/db/leave-type-allowances.ts`).
`tests/architecture/default-allowance.test.ts` lists every file that may read the field.

### Steps

On the caller's transaction, throwing `DomainError` to roll it back:

- `saveCompanySettings` and `changeDepartmentManager`: the change, its lock, the active-admin check and its audit
  row, returning before and after. Leave's `updateCompanySettings` adds the recount new working days cause, and
  approvals' `setDepartmentManager` re-routes the department's waiting requests; both send email after commit.
- `lockCompanyForChange`: `lockCompany` plus the company, for a change that needs its settings.
- `addDepartment`, `addLeaveType`, `applyLeaveTypeChanges`, `applyCompanyChanges`, `clearDepartmentsManagedBy`:
  writes with no audit row, for setup, imports and a person's deletion, which record the change themselves.
  `recordLeaveTypeChange` records a leave type change the way the use cases do.

## Inside

- `application/use-cases/`, `application/queries/`, `application/steps/`: one function per file.
- `application/policies.ts`, `application/dto.ts` (the DTOs and their mappers), and the shared parts of each kind of
  change: `company-changes.ts`, `department-changes.ts`, `level-changes.ts`, `leave-type-changes.ts`,
  `allowance-rule-removal.ts`, `logo-ref.ts`.
- The pure rules stay in `src/domain` (`company-settings`, `appearance`, `company-logo`, `leave-type-settings`,
  `color-mode`; `normalizeDepartmentName` / `normalizeLevelName` are in `src/shared/kernel/names.ts`): the schema, client components,
  `src/lib` and the TimeOff mapping use them too, and none of those can import a server-only module index.
- A person read (a department's manager, the names of a level's members) goes through the shared member directory,
  `src/shared/lib/db/members.ts`, never `@/modules/people`; the member counts that block a department's or level's
  removal are organisation's own (`countDepartmentMembers`, `countLevelMembers`).
