import type { Actor } from "@/domain/actor";
import { isEmptyBalance } from "@/domain/allowance-policy";
import { entriesCostingDaysIn } from "@/domain/calendar";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import { DomainError, isDomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { nextWorkingDay, WORKING_DAY_LOOKAHEAD } from "@/domain/leave-days";
import { canAddLeaveFor, canCorrectLeaveFor, canSeeLeaveDetails } from "@/domain/leave-permissions";
import { canRemoveOn } from "@/domain/request-status";
import { teamLabel } from "@/domain/person";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { listHolidayDates, listHolidays, listPersonLeave } from "@/server/repositories/calendar";
import { findCompany } from "@/server/repositories/companies";
import { findDepartment } from "@/server/repositories/departments";
import { listActiveLeaveTypesWithAllowance, listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { findPerson } from "@/server/repositories/users";
import { summarizeBalances } from "./balances";

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
 * - The person, admins, and their manager while the company allows it
 *   ({@link canSeeLeaveDetails}) also get `details`: this year's balances, and each
 *   request's days, note and approver's reason. For anyone else those are never read
 *   past the query, so they never leave the service.
 *
 * - An admin, or the person's direct manager ({@link canAddLeaveFor}), also gets
 *   `addLeave`: what the form to add time off for them needs (`addLeaveFor`), and each
 *   approved entry of the open year is `removable` by them (`removeLeaveFor`). They also
 *   get `earlier`: this year's leave from before the recent window.
 *
 * Inactive and deleted people are not on Team, so they are `not_found` here too.
 *
 * @throws DomainError `not_found`, `no_company`.
 */
export async function getTeamMember(ctx: ServiceContext, actor: Actor, userId: string) {
  if (!isUuid(userId)) throw new DomainError("not_found");
  const [company, person] = await Promise.all([findCompany(ctx.db, actor.companyId), findPerson(ctx.db, actor.companyId, userId)]);
  if (!company) throw new DomainError("no_company");
  if (!person?.isActive) throw new DomainError("not_found");

  const now = ctx.now();
  const today = todayInTimeZone(company.timezone, now);
  const from = fromEpochDay(toEpochDay(today) - RECENT_DAYS);
  const to = fromEpochDay(toEpochDay(today) + AHEAD_DAYS);
  const showDetails = canSeeLeaveDetails(actor, { ...person, companyId: actor.companyId }, company.managersSeeDetails);
  const year = yearInTimeZone(company.timezone, now);
  const canAdd = canAddLeaveFor(actor, { ...person, companyId: actor.companyId });
  const canCorrect = canCorrectLeaveFor(actor, { ...person, companyId: actor.companyId });
  // Someone who may correct the person's leave also sees this year's from before the recent window.
  const yearStart = `${year}-01-01`;
  const readFrom = canCorrect && yearStart < from ? yearStart : from;

  const [department, manager, holidays, leave, balances, addLeave] = await Promise.all([
    person.departmentId ? findDepartment(ctx.db, actor.companyId, person.departmentId) : undefined,
    person.managerId ? findPerson(ctx.db, actor.companyId, person.managerId) : undefined,
    listHolidays(ctx.db, actor.companyId, readFrom, to),
    listPersonLeave(ctx.db, actor.companyId, person.id, readFrom, to),
    showDetails ? personBalances(ctx, actor, person, company.allowancePolicy, year) : null,
    canAdd ? addLeaveForm(ctx, actor, today, company.workingDays) : null,
  ]);

  const shown = entriesCostingDaysIn(leave, { first: readFrom, last: to, workingDays: company.workingDays, holidays });
  const entries = shown.map(({ days, note, decisionNote, ...entry }) => ({
    ...entry,
    details: showDetails ? { days, note, decisionNote } : null,
    /** Whether the viewer may remove it to correct the record (`removeLeaveFor`): their manager or an admin, for approved leave of the open year. */
    removable: canCorrect && canRemoveOn(entry, today),
  }));
  return {
    person: {
      id: person.id,
      name: teamLabel(person),
      departmentName: department?.name ?? null,
      managerName: manager ? teamLabel(manager) : null,
      isMe: person.id === actor.id,
    },
    /** Leave that ends today or later, earliest first. */
    upcoming: entries.filter((e) => e.endDate >= today),
    /** Leave that ended in the last {@link RECENT_DAYS} days, latest first. */
    recent: entries.filter((e) => e.endDate < today && e.endDate >= from).reverse(),
    /**
     * For their manager or an admin only (`[]` for anyone else): this year's leave that ended
     * before the recent window, latest first, so it can still be corrected.
     */
    earlier: entries.filter((e) => e.endDate < from).reverse(),
    recentDays: RECENT_DAYS,
    /** The company's current year, which `earlier` covers. */
    year,
    /**
     * This year's balances, for those allowed to see them (types with nothing allotted
     * and nothing booked left out, as on Home); `null` otherwise, or when the policy is unknown.
     */
    balances: showDetails && balances ? { ...balances, items: balances.items.filter((i) => !isEmptyBalance(i.balance)) } : null,
    showDetails,
    /** The add-time-off form's leave types and default date, for an admin or their manager; `null` for anyone else. */
    addLeave,
  };
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
  return summarizeBalances(ctx.db, person, { allowancePolicy, types, year }).catch((err: unknown) => {
    if (!isDomainError(err, "policy_unavailable")) throw err;
    log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
    return null;
  });
}
