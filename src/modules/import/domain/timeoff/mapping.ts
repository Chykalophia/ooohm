/**
 * Maps a TimeOff.Management snapshot onto OOOhm's model: a pure plan the import service
 * then writes. Nothing here touches a database; every decision the importer makes about
 * the source data is made (and unit tested) here.
 *
 * The one real model difference is the allowance. TimeOff has **one pool per person and
 * year**, consumed by every leave type with `use_allowance`; OOOhm keeps an allowance
 * per leave type. The plan maps the pool onto one OOOhm leave type (the **pool type**),
 * so each person's remaining balance stays the same number:
 *
 * - The pool type is the TimeOff type named by `poolTypeName`, else the first
 *   `use_allowance` type by sort order. Its allowance rows carry the pool: `days` = the
 *   department allowance, `adjustment_days` = the year's adjustment plus TimeOff's
 *   pro-rating for a start or end year, `carried_over_days` = the year's carried-over
 *   allowance. It comes first in the leave type order, and its default allowance is
 *   the departments' allowance when they all have the same one (else none, with a
 *   `pool_type_no_default` warning), so people invited later are tracked too.
 * - When several TimeOff types use the pool, they can only keep one balance if they
 *   become one OOOhm type, so the plan refuses unless `mergePoolTypes` is set; then
 *   their leave all lands in the pool type, and each request keeps its original type
 *   name at the start of its note (`[TimeOff: Training] ...`). Splitting the pool into
 *   separate per-type allowances would have to invent how much of it each type gets, and
 *   would change what people see as left.
 * - Types without `use_allowance` import untracked, or, when TimeOff caps them with a
 *   yearly `limit`, as a tracked type whose default allowance is that limit.
 */
import { DomainError, isDomainError } from "@/shared/kernel/errors";
import { type AllowanceContext, planAllowances } from "./plan/allowances";
import { type CalendarPlan, planCalendars } from "./plan/calendars";
import { companyScope, planCompany } from "./plan/company";
import { type DepartmentPlan, planDepartments } from "./plan/departments";
import { planHolidays } from "./plan/holidays";
import { planLeaveTypes } from "./plan/leave-types";
import { type PeoplePlan, planPeople } from "./plan/people";
import { planRequests, type RequestPlan } from "./plan/requests";
import { selectTimeOffCompany } from "./plan/rules";
import type { ImportIssue, ImportPlan, ImportPlanOptions } from "./plan/types";
import type { TimeOffSnapshot } from "./source";

/**
 * Builds the import plan for one TimeOff company, one entity after another (each step in
 * `./plan/`): company, holidays, departments, people, leave types, working calendars,
 * requests, then allowances and TimeOff's balances.
 *
 * @throws DomainError `import_refused` when the file holds no company, several companies
 *   and none was chosen, an unknown `poolTypeName`, or several `use_allowance` types
 *   without `mergePoolTypes`. The message names the option that resolves it.
 */
export function buildImportPlan(snapshot: TimeOffSnapshot, options: ImportPlanOptions): ImportPlan {
  const warnings: ImportIssue[] = [];
  const conflicts: ImportIssue[] = [];
  const warn = (issue: ImportIssue) => warnings.push(issue);

  const scope = companyScope(snapshot, selectTimeOffCompany(snapshot, options.timeoffCompanyId));
  const company = planCompany(snapshot, scope.company, warn);
  const holidays = planHolidays(snapshot, scope.company.id, options.existingHolidays, warn);
  const departments = planDepartments(snapshot, scope.company.id, warn);
  const people = planPeople(scope, departments, options.today, warn, conflicts);
  const types = planLeaveTypes(scope.leaveTypes, departments.sourceDepartments, company, options, warn);
  const calendars = planCalendars(people.kept, snapshot, company.workingDays, holidays.holidayDates, warn);
  const leave = planRequests(
    { ...types, ...holidays, scope, keptIds: people.keptIds, personOf: people.personOf, calendars, companyCalendar: { workingDays: company.workingDays, holidays: holidays.ooohmHolidays } },
    warn,
  );
  const balances =
    types.poolKey === null
      ? { allowances: [], expected: [] }
      : planAllowances(people.kept, allowanceContext(snapshot, options, { poolKey: types.poolKey, poolDefault: types.poolDefault, people, departments, leave, calendars }), warn);

  return {
    company,
    departments: departments.departments,
    people: people.people,
    leaveTypes: types.leaveTypes,
    poolTypeKey: types.poolKey,
    holidays: holidays.holidays,
    allowances: balances.allowances,
    requests: leave.requests,
    expected: balances.expected,
    leaveCostDifferences: leave.differences,
    warnings,
    conflicts,
    skipped: { users: people.skippedUsers, leaves: leave.skippedLeaves },
  };
}

/** What the allowance step reads from the steps before it. */
function allowanceContext(
  snapshot: TimeOffSnapshot,
  options: ImportPlanOptions,
  before: { poolKey: string; poolDefault: number | null; people: PeoplePlan; departments: DepartmentPlan; leave: RequestPlan; calendars: CalendarPlan },
): AllowanceContext {
  return {
    options,
    poolKey: before.poolKey,
    poolDefault: before.poolDefault,
    people: before.people.people,
    departmentById: before.departments.departmentById,
    poolLeavesOf: before.leave.poolLeavesOf,
    calendarOf: before.calendars.calendarOf,
    adjustments: snapshot.adjustments,
    adjustmentOf: new Map(snapshot.adjustments.map((a) => [`${a.userId}|${a.year}`, a])),
  };
}

/** Whether `err` is the planner's refusal (as opposed to a bug). */
export function isImportRefusal(err: unknown): err is DomainError {
  return isDomainError(err, "import_refused");
}
