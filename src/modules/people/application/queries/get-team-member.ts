import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { isEmptyBalance, summarizeBalances } from "@/modules/balances";
import { entriesCostingDaysIn } from "@/shared/kernel/calendar";
import { canSeeOnCalendar } from "@/shared/kernel/calendar-visibility";
import { fromEpochDay, toEpochDay } from "@/shared/kernel/calendar-date";
import { DomainError, isDomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import { nextWorkingDay, WORKING_DAY_LOOKAHEAD } from "@/shared/kernel/leave-days";
import { canAddLeaveFor, canCorrectLeaveFor, canRemoveOn, canSeeLeaveDetails } from "@/modules/leave";
import { teamLabel } from "@/shared/kernel/person-label";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { listHolidayDates, listHolidays, listPersonLeave, scopeOf } from "@/modules/calendar";
import { findCompany, findDepartment } from "@/modules/organisation";
import { listActiveLeaveTypesWithAllowance, listLeaveTypesWithAllowance } from "@/shared/lib/db/leave-type-allowances";
import { findPerson } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** How far back "Recently" looks, and how far ahead "Coming up" does, in days. */
const RECENT_DAYS = 60;
const AHEAD_DAYS = 365;

/**
 * One member of the actor's company, as their page on Team shows them, in two tiers:
 *
 * - Everyone in the company sees what the team calendar already shows: name,
 *   department, manager, and their approved and pending leave from
 *   {@link RECENT_DAYS} days ago to {@link AHEAD_DAYS} days ahead (only leave that costs
 *   a working day, as on the calendar).
 * - The person, admins, and their manager or department's manager while the company allows it
 *   ({@link canSeeLeaveDetails}) also get `details`: this year's balances, and each
 *   request's days, note and approver's reason. For anyone else those are never read
 *   past the query, so they never leave the service.
 *
 * - An admin, or the person's direct or department manager ({@link canAddLeaveFor}), also gets
 *   `addLeave`: what the form to add time off for them needs (`addLeaveFor`), and each
 *   approved entry of the open year is `removable` by them (`removeLeaveFor`). They also
 *   get `earlier`: this year's leave from before the recent window.
 *
 * Inactive and deleted people are not on Team, so they are `not_found` here too, as is
 * anyone outside the people the actor may see (`calendarScopeFor`). Fails with
 * `not_found` or `no_company`.
 */
export async function getTeamMember(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<TeamMemberDTO>> {
  if (!isUuid(userId)) return err("not_found");
  return attempt(() => teamMemberOf(ctx, actor, userId));
}

/** What a member's Team page shows; see {@link getTeamMember}. */
export type TeamMemberDTO = Awaited<ReturnType<typeof teamMemberOf>>;

async function teamMemberOf(ctx: ServiceContext, actor: Actor, userId: string) {
  const { company, person } = await visiblePerson(ctx, actor, userId);
  const now = ctx.now();
  const today = todayInTimeZone(company.timezone, now);
  const year = yearInTimeZone(company.timezone, now);
  const [department, manager] = await Promise.all([
    person.departmentId ? findDepartment(ctx.db, actor.companyId, person.departmentId) : undefined,
    person.managerId ? findPerson(ctx.db, actor.companyId, person.managerId) : undefined,
  ]);
  const may = viewerRights(actor, person, department?.managerId ?? null, company.managersSeeDetails);
  const window = leaveWindow(today, year, may.correct);
  const [holidays, leave, balances, addLeave] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, window.readFrom, window.to),
    listPersonLeave(ctx.db, actor.companyId, person.id, window.readFrom, window.to),
    may.details ? personBalances(ctx, actor, person, company.allowancePolicy, year) : null,
    may.add ? addLeaveForm(ctx, actor, today, company.workingDays) : null,
  ]);
  const shown = entriesCostingDaysIn(leave, { first: window.readFrom, last: window.to, workingDays: company.workingDays, holidays });
  const entries = shown.map(({ days, note, decisionNote, ...entry }) => ({
    ...entry,
    details: may.details ? { days, note, decisionNote } : null,
    /** Whether the viewer may remove it to correct the record (`removeLeaveFor`): their manager or an admin, for approved leave of the open year. */
    removable: may.correct && canRemoveOn(entry, today),
  }));
  return {
    person: {
      id: person.id,
      name: teamLabel(person),
      departmentName: department?.name ?? null,
      managerName: manager ? teamLabel(manager) : null,
      isMe: person.id === actor.id,
    },
    upcoming: entries.filter((e) => e.endDate >= today),
    recent: entries.filter((e) => e.endDate < today && e.endDate >= window.from).reverse(),
    earlier: entries.filter((e) => e.endDate < window.from).reverse(),
    recentDays: RECENT_DAYS,
    year,
    balances: may.details && balances ? { ...balances, items: balances.items.filter((i) => !isEmptyBalance(i.balance)) } : null,
    showDetails: may.details,
    addLeave,
  };
}

/**
 * The company and the person, when the actor may see them on Team: active, and inside
 * the people the actor may see (`calendarScopeFor`).
 *
 * @throws DomainError `not_found`, `no_company`.
 */
async function visiblePerson(ctx: ServiceContext, actor: Actor, userId: string) {
  const [company, person, viewer] = await Promise.all([
    findCompany(ctx.db, actor.companyId),
    findPerson(ctx.db, actor.companyId, userId),
    userId === actor.id ? undefined : findPerson(ctx.db, actor.companyId, actor.id),
  ]);
  if (!company) throw new DomainError("no_company");
  if (!person?.isActive) throw new DomainError("not_found");
  const me = userId === actor.id ? person : viewer;
  const scope = await scopeOf(ctx.db, actor.companyId, { id: actor.id, role: actor.role, managerId: me?.managerId ?? null, departmentId: me?.departmentId ?? null }, company);
  if (!canSeeOnCalendar(scope, person)) throw new DomainError("not_found");
  return { company, person };
}

/** Who manages the person (their manager, or their department's) decides the details, the add form and corrections. */
function viewerRights(actor: Actor, person: { id: string; managerId: string | null }, departmentManagerId: string | null, managersSeeDetails: boolean) {
  const owned = { id: person.id, companyId: actor.companyId, managerId: person.managerId, departmentManagerId };
  return {
    details: canSeeLeaveDetails(actor, owned, managersSeeDetails),
    add: canAddLeaveFor(actor, owned),
    correct: canCorrectLeaveFor(actor, owned),
  };
}

/** The dates read: the recent window and the year ahead, from the start of the year for someone who may correct their leave. */
function leaveWindow(today: string, year: number, canCorrect: boolean) {
  const from = fromEpochDay(toEpochDay(today) - RECENT_DAYS);
  const to = fromEpochDay(toEpochDay(today) + AHEAD_DAYS);
  const yearStart = `${year}-01-01`;
  return { from, to, readFrom: canCorrect && yearStart < from ? yearStart : from };
}

/** What the form to add time off for someone needs: active leave types (the first is its default) and the next working day. */
async function addLeaveForm(ctx: ServiceContext, actor: Actor, today: string, workingDays: number[]) {
  const lookaheadEnd = fromEpochDay(toEpochDay(today) + WORKING_DAY_LOOKAHEAD - 1);
  const [types, holidays] = await Promise.all([
    listActiveLeaveTypesWithAllowance(ctx.db, actor.companyId),
    listHolidayDates(ctx.db, actor.companyId, today, lookaheadEnd),
  ]);
  return {
    leaveTypes: types.map(({ id, name, color }) => ({ id, name, color })),
    defaultDate: nextWorkingDay(today, { workingDays, holidays }),
  };
}

/** The person's balances for `year`, or `null` (logged) when the company's allowance policy is unknown. */
async function personBalances(ctx: ServiceContext, actor: Actor, person: { id: string }, allowancePolicy: string, year: number) {
  const types = await listLeaveTypesWithAllowance(ctx.db, actor.companyId);
  return summarizeBalances(ctx.db, { id: person.id, companyId: actor.companyId }, { allowancePolicy, types, year }).catch((err: unknown) => {
    if (!isDomainError(err, "policy_unavailable")) throw err;
    log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
    return null;
  });
}
