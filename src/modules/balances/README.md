# balances

**Tier 3.** How much leave each person has: the allowance policy, balances and the live preview's cost, allowance
rules per department and level, an admin's override of one person's allowance, and the year rollover. The policy is
a Strategy resolved by key, the use cases depend on ports, and the use-case tests run on in-memory fakes.

## Owns

The `allowances` and `allowance_rules` tables, through `infrastructure/drizzle-allowance.repository.ts` and
`drizzle-allowance-rule.repository.ts`. It reads the booked days in `leave_request_days` (leave writes them), and
the leave type settings and active requests through `src/shared/lib/db/leave-type-allowances.ts` and
`leave-requests.ts` (calendar reads them too, and leave imports balances, so neither sits behind an index). Organisation removes the rules
of a department or level it deletes (`allowance-rule-removal.ts` there).

## Rules it keeps

- The policy is pluggable: `annual_calendar_year` is the one `AllowancePolicy` in the registry; nothing branches on
  the key.
- Every balance reads a person's default allowance through `loadAllowanceDefaults`: the most specific allowance rule
  (department and level, then level, then department), else the type's own default. The rule arithmetic is not
  exported, and `tests/architecture/default-allowance.test.ts` lists where `defaultAllowanceDays` may be read.
- Carryover is per leave type and off by default, capped by `carryoverMaxDays`. The year rollover is idempotent and
  owns `carried_over_days`.
- Every allowance change writes an audit row and a `balance.adjusted` event in its transaction (`recordChange`);
  an admin's reason stays in the audit row only.

## Public API (`index.ts`)

Use cases and queries, each `(ctx, …)` → `ServiceResult`: `setAllowanceOverride`, `setAllowanceRule`,
`removeAllowanceRule`, `runYearRollover`, `getBalanceSummary`, `previewLeaveRequest`, `getAllowanceRulesForm`,
`listAllowanceRulesForAdmin`. Policies: `canEditAllowances`, `canManageAllowanceRules`.

On the caller's executor, for other modules' and services' transactions (plain values; a `DomainError` throws):
`loadAllowanceDefaults`, `loadBalanceInputs`, `loadBalances`, `summarizeBalances`, `assessLeaveRequest` (leave's
submit and preview), `recarryMemberLeaveType` (leave and the TimeOff import), `writeAllowance` and `findAllowance`
(the inbound sync), `followDefaults` (a move between departments or levels), and `listAllowances`,
`sumBookedDays` with `balanceInputs` and `allowanceYearsFor` (the REST API's balance list). Every balance read is
scoped to a company (`BalanceScope.companyId`): allowances and booked days of another company's people read as none.

The policy: `resolveAllowancePolicy`, `ALLOWANCE_POLICY_KEYS`, `ANNUAL_CALENDAR_YEAR`, the `Balance`,
`RequestCost` and `AllowancePolicy` types, `isEmptyBalance`, `remainingAfter`, `findShortfall`, `assertCovered`
and `addDays`. DTO types; never a row.

## Inside

- `domain/`: `allowance-policy.ts` (the Strategy's interface, balances and charges),
  `annual-calendar-year-policy.ts` (v1), `policy-registry.ts`, `allowance-rules.ts` (the most specific rule wins,
  `AllowanceDefaults`), `allowance.ts` (the balance lookup over allowance rows and booked days) and `rollover.ts`
  (which types one person's rollover touches, and the step for each). Pure.
- `application/ports.ts`: `AllowanceRepository`, `AllowanceRuleRepository`, `BalancesDirectory` (companies,
  calendars, people, leave types, departments, levels, locks), `ChangeLog`, `Clock`, and `BalancesDeps` with its
  `unitOfWork(companyId, …)` and `tenant(companyId)` (row-level security's company, ADR-0004: the rollover reads and writes each company through it).
- `application/use-cases/` and `application/queries/`: one file each. `member-rollover.ts` (one person's
  rollover, and the re-carry after an edit), `write-allowance.ts`, `follow-defaults.ts`, `rule-change.ts` and
  `allowance-changes.ts` are the steps they share.
- `infrastructure/`: the two Drizzle repositories, the directory on the old repositories and organisation, and the
  change log on `recordChange` and `recordAdminChange`.
- `composition.ts`: binds the ports to a transaction (`balancesStore`, `balancesDeps`); the index exports its
  ctx- and executor-taking functions.

## Tests

- `tests/unit/modules/balances/`: the domain (`allowance-default`, `balance`, `allowance-policy`, `allowance-rules`,
  `policy-registry`), the use cases on fakes (`use-cases/`: rollover, edit-allowance, allowance-rule), and
  `public-api.test.ts`.
- `fakes/`: `InMemoryAllowanceRepository`, the rule repository and directory fakes, and `balancesKit()`, whose unit
  of work rolls back on a throw.
- `contracts/allowance-repository.contract.ts`: `allowanceRepositoryContract`, run on the fake in `pnpm test` and on
  Drizzle in `tests/integration/modules/balances/` (both drivers).
