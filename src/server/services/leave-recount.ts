/**
 * Recounting submitted leave after the company calendar changed.
 *
 * A request stores what it cost when it was submitted (`leave_requests.days` and the
 * per-year split in `leave_request_days`). When an admin adds or deletes a company
 * holiday, or changes the working days, the pending and approved requests on the
 * affected dates are recounted, so nobody pays for a day that is now a holiday, or
 * gets one free that no longer is.
 *
 * - Only what the change itself makes different is applied ({@link applyCalendarChange}):
 *   each request is counted with the calendar before and after, and its stored split
 *   moves by the difference. An earlier correction to the split is never undone, and the
 *   email names only this change.
 * - Only years still open are recounted. Years before the current one (in the company's
 *   time zone) keep their stored days: their balances are settled and carried over, and
 *   a past year is corrected with a balance adjustment instead.
 * - A request that now falls entirely on non-working days is kept, at 0 days, rather than
 *   cancelled. Nothing comes off the balance, the person can still cancel it, and undoing
 *   the change (deleting the holiday again, re-ticking the day) restores its count. So a
 *   mistaken change never destroys anyone's leave.
 * - A request that now costs more is kept even if it overdraws the balance, because the
 *   time was already booked. The admin is told who is over, and so is the person.
 *
 * Each change is recorded as the admin's, through `holiday_change` or
 * `working_days_change` (`leave_request.recounted` / `leave.recounted`), and the
 * requester is emailed after commit, once per request whose total changed.
 *
 * The caller holds `lockCompany` for the whole transaction. Leave submits hold the same
 * row `FOR SHARE` (`shareLockCompany`) while counting, so no request counted with the old
 * calendar can commit unseen while a recount runs.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { type AllowancePolicy, addDays, resolveAllowancePolicy } from "@/domain/allowance-policy";
import { CHANGE_PROCESSES, through } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { applyCalendarChange, sameSplit, type YearDays } from "@/domain/leave-days";
import { personLabel } from "@/domain/person";
import { yearInTimeZone } from "@/lib/dates";
import { formatDays, type RecountCause } from "@/lib/format";
import type { ServiceContext } from "@/server/context";
import { renderLeaveEmail } from "@/server/email/leave-emails";
import { listAllowances, listRequestDays, replaceRequestDays, sumBookedDays } from "@/server/repositories/balances";
import { findCompanySettings, listHolidayDates } from "@/server/repositories/calendar";
import { type LeaveRequestRow, lockActiveRequestsOnDates, updateRequestDays } from "@/server/repositories/leave-requests";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { findContacts } from "@/server/repositories/users";
import { allowanceYearsFor, balanceInputs } from "./balances";
import { recordRecount, summarize } from "./leave-changes";
import type { DeferredEmail } from "./notify";

/** A company holiday as a recount describes it. */
export interface HolidayFact {
  date: string;
  name: string;
}

/**
 * What changed in the company calendar. Holidays are already added or deleted, and the
 * working days already saved, when {@link recountLeave} runs.
 */
export type CalendarChange =
  | { kind: "holidays"; added: readonly HolidayFact[]; removed: readonly HolidayFact[] }
  | { kind: "working_days"; previous: readonly number[] };

/** A balance a recount pushed below zero. */
export interface OverdrawnBalance {
  userId: string;
  leaveTypeId: string;
  personName: string;
  leaveTypeName: string;
  year: number;
  /** Days over, positive. */
  over: number;
}

/** What a recount changed, for the admin's confirmation. */
export interface RecountOutcome {
  /** Requests whose count changed. */
  recounted: number;
  /** Of those, how many now fall entirely on non-working days and cost nothing. */
  nowFree: number;
  /** Balances the recount left below zero. */
  overdrawn: OverdrawnBalance[];
}

export const NOTHING_RECOUNTED: RecountOutcome = { recounted: 0, nowFree: 0, overdrawn: [] };

/**
 * Recounts the company's pending and approved requests touched by `change`, inside `tx`
 * (see the module docblock for the rules).
 *
 * @returns What changed, and the emails to send once `tx` commits (pass them to `commitThenSend`).
 * @throws DomainError `no_company`, or `policy_unavailable` when the company's
 *   allowance policy is unknown.
 */
export async function recountLeave(
  tx: Transaction,
  ctx: ServiceContext,
  actor: Actor,
  change: CalendarChange,
): Promise<{ outcome: RecountOutcome; outgoing: DeferredEmail[] }> {
  const settings = await findCompanySettings(tx, actor.companyId);
  if (!settings) throw new DomainError("no_company");
  const policy = resolveAllowancePolicy(settings.allowancePolicy);
  const firstOpenYear = yearInTimeZone(settings.timezone, ctx.now());
  const openFrom = `${firstOpenYear}-01-01`;

  // Holiday changes touch only requests on those dates (in open years); working days touch every open request.
  const dates = change.kind === "holidays" ? [...change.added, ...change.removed].map((h) => h.date).filter((d) => d >= openFrom) : null;
  if (dates?.length === 0) return { outcome: NOTHING_RECOUNTED, outgoing: [] };
  const touched = await lockActiveRequestsOnDates(tx, actor.companyId, dates ?? { from: openFrom });
  if (touched.length === 0) return { outcome: NOTHING_RECOUNTED, outgoing: [] };

  const window = {
    from: touched.reduce((min, r) => (r.startDate < min ? r.startDate : min), touched[0].startDate),
    to: touched.reduce((max, r) => (r.endDate > max ? r.endDate : max), touched[0].endDate),
  };
  const [holidays, stored, types] = await Promise.all([
    listHolidayDates(tx, actor.companyId, window.from, window.to),
    listRequestDays(tx, touched.map((r) => r.id)),
    listLeaveTypesWithAllowance(tx, actor.companyId),
  ]);
  const now = { workingDays: settings.workingDays, holidays };
  const then = calendarBefore(change, now);
  const source = through(actor.source, change.kind === "holidays" ? CHANGE_PROCESSES.holidayChange : CHANGE_PROCESSES.workingDaysChange);

  const changed: { before: LeaveRequestRow; after: LeaveRequestRow; grew: YearDays[] }[] = [];
  for (const row of touched) {
    const kept = stored.get(row.id) ?? [];
    const next = applyCalendarChange(kept, policy.periodsFor(row, then), policy.periodsFor(row, now), firstOpenYear);
    if (sameSplit(kept, next)) continue;
    await replaceRequestDays(tx, row.id, next);
    const after = await updateRequestDays(tx, actor.companyId, row.id, addDays(...next.map((y) => y.days)));
    await recordRecount(tx, { before: row, after, source });
    changed.push({ before: row, after, grew: next.filter((y) => y.days > (kept.find((k) => k.year === y.year)?.days ?? 0)) });
  }
  if (changed.length === 0) return { outcome: NOTHING_RECOUNTED, outgoing: [] };

  const typeById = new Map(types.map((t) => [t.id, t]));
  // Everyone affected, for names; only active people are emailed.
  const people = new Map(
    (await findContacts(tx, actor.companyId, [...new Set(changed.map((c) => c.after.userId))])).map((p) => [p.id, p]),
  );
  const overdrawn = await findOverdrawn(tx, policy, typeById, changed, people);

  const outgoing: DeferredEmail[] = [];
  for (const { before, after, grew } of changed) {
    const person = people.get(after.userId);
    // A move between years alone (same total) changes no one's plans: audited, not emailed.
    if (!person?.isActive || after.days === before.days) continue;
    const typeName = typeById.get(after.leaveTypeId)?.name ?? "Leave";
    const over = overdrawn.find(
      (o) => o.userId === after.userId && o.leaveTypeId === after.leaveTypeId && grew.some((g) => g.year === o.year),
    );
    const email = {
      kind: "recounted" as const,
      recipientName: person.name,
      leave: summarize(after, person, typeName),
      previousDays: before.days,
      cause: causeFor(change, after),
      overdrawn: over ? `${formatDays(over.over)} over your ${typeName} balance for ${over.year}` : null,
      link: `${ctx.appUrl}/`,
    };
    outgoing.push({
      to: person.email,
      build: () => renderLeaveEmail(email),
      failureEvent: "leave_email_failed",
      logFields: { requestId: after.id, kind: email.kind },
    });
  }

  return {
    outcome: { recounted: changed.length, nowFree: changed.filter((c) => c.after.days === 0).length, overdrawn },
    outgoing,
  };
}

/** The calendar as it was before `change`, given the one in force now. */
function calendarBefore(
  change: CalendarChange,
  now: { workingDays: readonly number[]; holidays: readonly string[] },
): { workingDays: readonly number[]; holidays: readonly string[] } {
  if (change.kind === "working_days") return { workingDays: change.previous, holidays: now.holidays };
  const added = new Set(change.added.map((h) => h.date));
  return {
    workingDays: now.workingDays,
    holidays: [...now.holidays.filter((d) => !added.has(d)), ...change.removed.map((h) => h.date)],
  };
}

/** The part of `change` that falls on one request's dates, for its email. */
function causeFor(change: CalendarChange, request: { startDate: string; endDate: string }): RecountCause {
  if (change.kind === "working_days") return { kind: "working_days" };
  const within = (h: HolidayFact) => request.startDate <= h.date && h.date <= request.endDate;
  return { kind: "holidays", added: change.added.filter(within), removed: change.removed.filter(within) };
}

/**
 * The tracked balances, among the years a recount charged more, that are now below
 * zero. Two queries (allowance rows and booked days) for all of them.
 */
async function findOverdrawn(
  tx: Transaction,
  policy: AllowancePolicy,
  typeById: Map<string, Awaited<ReturnType<typeof listLeaveTypesWithAllowance>>[number]>,
  changed: readonly { after: LeaveRequestRow; grew: readonly YearDays[] }[],
  people: Map<string, { name: string; email: string }>,
): Promise<OverdrawnBalance[]> {
  const keys = new Map<string, { userId: string; leaveTypeId: string; year: number }>();
  for (const { after, grew } of changed) {
    for (const { year } of grew) keys.set(`${after.userId}|${after.leaveTypeId}|${year}`, { userId: after.userId, leaveTypeId: after.leaveTypeId, year });
  }
  if (keys.size === 0) return [];
  const all = [...keys.values()];
  const scope = {
    userIds: [...new Set(all.map((k) => k.userId))],
    leaveTypeIds: [...new Set(all.map((k) => k.leaveTypeId))],
  };
  const years = [...new Set(all.map((k) => k.year))];
  const [allowanceRows, bookedRows] = await Promise.all([
    listAllowances(tx, { ...scope, years: allowanceYearsFor(years) }),
    sumBookedDays(tx, { ...scope, years }),
  ]);
  const inputs = balanceInputs(allowanceRows, bookedRows);

  const overdrawn: OverdrawnBalance[] = [];
  for (const { userId, leaveTypeId, year } of all) {
    const type = typeById.get(leaveTypeId);
    if (!type) continue;
    const balance = inputs.balance(policy, type, userId, year);
    if (!balance.tracked || balance.remaining >= 0) continue;
    const person = people.get(userId);
    overdrawn.push({
      userId,
      leaveTypeId,
      personName: person ? personLabel(person) : "Someone",
      leaveTypeName: type.name,
      year,
      over: -balance.remaining,
    });
  }
  return overdrawn;
}
