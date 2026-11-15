import "server-only";
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
import type { Actor } from "@/domain/actor";
import { type AllowancePolicy, addDays, type LeaveTypeWithAllowance, resolveAllowancePolicy } from "@/modules/balances";
import { CHANGE_PROCESSES, type PersonChangeSource, through } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { personLabel } from "@/domain/person";
import { yearInTimeZone } from "@/lib/dates";
import { formatDays, type RecountCause } from "@/lib/format";
import type { Notification } from "@/modules/notifications";
import type { YearDays } from "@/shared/kernel/leave-days";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import type { LeaveRequest } from "../../domain/leave-request";
import { applyCalendarChange, sameSplit } from "../../domain/recount";
import { recordRecountIn, summarize } from "../leave-changes";
import type { Contact, LeaveDeps, LeaveStore } from "../ports";

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

/** One request the recount changed, and the years it grew into. */
interface Recounted {
  before: LeaveRequest;
  after: LeaveRequest;
  grew: YearDays[];
}

/** What a recount returns: its outcome, and the emails to send once the caller's transaction commits. */
export interface Recount {
  outcome: RecountOutcome;
  notify: Notification[];
}

/**
 * Recounts the company's pending and approved requests touched by `change`, inside the
 * caller's unit of work, whose ports `store` is bound to (see the module docblock for the
 * rules). The caller unwraps a failure so its transaction rolls back.
 *
 * Fails with `no_company`, or `policy_unavailable` when the company's allowance policy is unknown.
 */
export async function recountLeave(deps: LeaveDeps, store: LeaveStore, actor: Actor, change: CalendarChange): Promise<ServiceResult<Recount>> {
  return attempt(async () => {
    const settings = await store.directory.companySettings(actor.companyId);
    if (!settings) throw new DomainError("no_company");
    const policy = resolveAllowancePolicy(settings.allowancePolicy);
    const firstOpenYear = yearInTimeZone(settings.timezone, deps.clock.now());
    const openFrom = `${firstOpenYear}-01-01`;

    // Holiday changes touch only requests on those dates (in open years); working days touch every open request.
    const dates = change.kind === "holidays" ? [...change.added, ...change.removed].map((h) => h.date).filter((d) => d >= openFrom) : null;
    if (dates?.length === 0) return { outcome: NOTHING_RECOUNTED, notify: [] };
    const touched = await store.requests.lockActiveOnDates(actor.companyId, dates ?? { from: openFrom });
    if (touched.length === 0) return { outcome: NOTHING_RECOUNTED, notify: [] };

    const window = {
      from: touched.reduce((min, r) => (r.startDate < min ? r.startDate : min), touched[0].startDate),
      to: touched.reduce((max, r) => (r.endDate > max ? r.endDate : max), touched[0].endDate),
    };
    const [holidays, stored, types] = await Promise.all([
      store.directory.holidayDates(actor.companyId, window.from, window.to),
      store.requests.listYearDays(touched.map((r) => r.id)),
      store.directory.leaveTypesWithAllowance(actor.companyId),
    ]);
    const now = { workingDays: settings.workingDays, holidays };
    const source = through(actor.source, change.kind === "holidays" ? CHANGE_PROCESSES.holidayChange : CHANGE_PROCESSES.workingDaysChange);
    const calendars = { then: calendarBefore(change, now), now };
    const changed = await applyRecounts(store, actor, { touched, stored, policy, firstOpenYear, calendars, source });
    if (changed.length === 0) return { outcome: NOTHING_RECOUNTED, notify: [] };

    const typeById = new Map(types.map((t) => [t.id, t]));
    // Everyone affected, for names; only active people are emailed.
    const people = new Map((await store.directory.contacts(actor.companyId, [...new Set(changed.map((c) => c.after.userId))])).map((p) => [p.id, p]));
    const overdrawn = await findOverdrawn(store, actor.companyId, { policy, typeById, changed, people });
    return {
      outcome: { recounted: changed.length, nowFree: changed.filter((c) => c.after.days === 0).length, overdrawn },
      notify: recountMail(deps, change, { changed, typeById, people, overdrawn }),
    };
  });
}

type WorkCalendarNow = { workingDays: readonly number[]; holidays: readonly string[] };

/** Moves each touched request's stored split by what the change made different, recording each one that changed. */
async function applyRecounts(
  store: LeaveStore,
  actor: Actor,
  job: {
    touched: readonly LeaveRequest[];
    stored: Map<string, YearDays[]>;
    policy: AllowancePolicy;
    firstOpenYear: number;
    calendars: { then: WorkCalendarNow; now: WorkCalendarNow };
    source: PersonChangeSource;
  },
): Promise<Recounted[]> {
  const changed: Recounted[] = [];
  for (const row of job.touched) {
    const kept = job.stored.get(row.id) ?? [];
    const next = applyCalendarChange(kept, job.policy.periodsFor(row, job.calendars.then), job.policy.periodsFor(row, job.calendars.now), job.firstOpenYear);
    if (sameSplit(kept, next)) continue;
    await store.requests.replaceYearDays(row.id, next);
    const after = await store.requests.updateDays(actor.companyId, row.id, addDays(...next.map((y) => y.days)));
    await recordRecountIn(store.changes, { before: row, after, source: job.source });
    changed.push({ before: row, after, grew: next.filter((y) => y.days > (kept.find((k) => k.year === y.year)?.days ?? 0)) });
  }
  return changed;
}

/** `leave.recounted` to each active person whose request's total changed, or who is now over a balance. */
function recountMail(
  deps: LeaveDeps,
  change: CalendarChange,
  facts: { changed: readonly Recounted[]; typeById: Map<string, LeaveTypeWithAllowance>; people: Map<string, Contact>; overdrawn: readonly OverdrawnBalance[] },
): Notification[] {
  const notify: Notification[] = [];
  for (const { before, after, grew } of facts.changed) {
    const person = facts.people.get(after.userId);
    if (!person?.isActive) continue;
    const typeName = facts.typeById.get(after.leaveTypeId)?.name ?? "Leave";
    // Every year this request grew into that is now over: a request across New Year can overdraw both.
    const overs = facts.overdrawn.filter((o) => o.userId === after.userId && o.leaveTypeId === after.leaveTypeId && grew.some((g) => g.year === o.year));
    // A move between years alone (same total) changes no one's plans, unless it leaves
    // them over a balance: then they hear it, as the admin does.
    if (after.days === before.days && overs.length === 0) continue;
    notify.push({
      type: "leave.recounted",
      to: person.email,
      data: {
        requestId: after.id,
        recipientName: person.name,
        leave: summarize(after, person, typeName),
        previousDays: before.days,
        cause: causeFor(change, after),
        overdrawn: overs.length > 0 ? overs.map((o) => `${formatDays(o.over)} over your ${typeName} balance for ${o.year}`).join(" and ") : null,
        link: `${deps.appUrl}/`,
      },
    });
  }
  return notify;
}

/** The calendar as it was before `change`, given the one in force now. */
function calendarBefore(change: CalendarChange, now: WorkCalendarNow): WorkCalendarNow {
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
 * zero. Four queries at most (allowance rows, booked days, allowance rules and
 * where the people sit) for all of them.
 */
async function findOverdrawn(
  store: LeaveStore,
  companyId: string,
  facts: { policy: AllowancePolicy; typeById: Map<string, LeaveTypeWithAllowance>; changed: readonly Recounted[]; people: Map<string, { name: string; email: string }> },
): Promise<OverdrawnBalance[]> {
  const keys = new Map<string, { userId: string; leaveTypeId: string; year: number }>();
  for (const { after, grew } of facts.changed) {
    for (const { year } of grew) keys.set(`${after.userId}|${after.leaveTypeId}|${year}`, { userId: after.userId, leaveTypeId: after.leaveTypeId, year });
  }
  if (keys.size === 0) return [];
  const all = [...keys.values()];
  const inputs = await store.allowances.balancesFor(companyId, {
    userIds: [...new Set(all.map((k) => k.userId))],
    leaveTypeIds: [...new Set(all.map((k) => k.leaveTypeId))],
    years: [...new Set(all.map((k) => k.year))],
  });
  return all.flatMap(({ userId, leaveTypeId, year }) => {
    const type = facts.typeById.get(leaveTypeId);
    if (!type) return [];
    const balance = inputs.balance(facts.policy, type, userId, year);
    if (!balance.tracked || balance.remaining >= 0) return [];
    const person = facts.people.get(userId);
    return [{ userId, leaveTypeId, personName: person ? personLabel(person) : "Someone", leaveTypeName: type.name, year, over: -balance.remaining }];
  });
}
