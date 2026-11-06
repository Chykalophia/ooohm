import type { Executor } from "@/db/types";
import type { Actor } from "@/domain/actor";
import {
  type AllowancePolicy,
  type AllowanceRecord,
  assertCovered,
  type Balance,
  type BookedDays,
  type LeaveTypeAllowanceSettings,
  type PeriodCharge,
  type RequestCost,
  remainingAfter,
  resolveAllowancePolicy,
} from "@/domain/allowance-policy";
import { defaultAllowanceFor } from "@/domain/allowance-rules";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { assertValidRange, type DayPortion, type LeaveRange, rangesOverlap } from "@/domain/leave-request";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listAllowanceRules, listPlacements } from "@/server/repositories/allowance-rules";
import { type AllowanceRow, listAllowances, sumBookedDays } from "@/server/repositories/balances";
import { findCompanySettings, listHolidayDates, listHolidays } from "@/server/repositories/calendar";
import { listActiveRequestsInRange } from "@/server/repositories/leave-requests";
import { findActiveLeaveType, listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";

/** The date and type part of a leave request, before it is stored. */
export interface LeaveDraft {
  leaveTypeId: string;
  startDate: string;
  /** Defaults to `startDate` when empty. */
  endDate?: string | null;
  dayPortion: DayPortion;
}

export function draftRange(draft: LeaveDraft): LeaveRange {
  return { startDate: draft.startDate, endDate: draft.endDate || draft.startDate, dayPortion: draft.dayPortion };
}

const NOTHING_BOOKED: BookedDays = { approved: 0, pending: 0 };

/**
 * Each person's default yearly allowance of a leave type: the allowance rule for their
 * department and level ({@link defaultAllowanceFor}), else the type's own default.
 */
export type AllowanceDefaults = (userId: string, leaveType: { id: string; defaultAllowanceDays: number | null }) => number | null;

/** {@link AllowanceDefaults} when no rule applies: every type's own default. */
export const typeDefaults: AllowanceDefaults = (_userId, leaveType) => leaveType.defaultAllowanceDays;

/**
 * The company's {@link AllowanceDefaults} for `userIds`, read in `ex`: one query for
 * the rules, and one more for where the people sit only when the company has any.
 */
export async function loadAllowanceDefaults(ex: Executor, companyId: string, userIds: readonly string[]): Promise<AllowanceDefaults> {
  const rules = await listAllowanceRules(ex, companyId);
  if (rules.length === 0) return typeDefaults;
  const placements = await listPlacements(ex, companyId, userIds);
  return (userId, leaveType) => defaultAllowanceFor(leaveType, placements.get(userId) ?? NOWHERE, rules);
}

const NOWHERE = { departmentId: null, levelId: null } as const;

/** The allowance years to load for balances of `years`: each year and the one after it. */
export function allowanceYearsFor(years: readonly number[]): number[] {
  return [...new Set(years.flatMap((y) => [y, y + 1]))];
}

/**
 * Indexes allowance rows and booked-day sums by person, leave type and year, so many
 * balances can be computed from two queries.
 *
 * A year's balance counts the next year's `carried_over_days` as carried out of it,
 * and a type without a default inherits the person's latest earlier row. So
 * `allowanceRows` must come from {@link listAllowances} over each balance year and the
 * year after it (see {@link allowanceYearsFor}), which also returns the latest row
 * before them; a missing next-year row reads as nothing carried out.
 */
export function balanceInputs(
  allowanceRows: readonly AllowanceRow[],
  bookedRows: readonly ({ userId: string; leaveTypeId: string; year: number } & BookedDays)[],
  defaults: AllowanceDefaults,
) {
  const key = (userId: string, leaveTypeId: string, year: number) => `${userId}|${leaveTypeId}|${year}`;
  const allowance = new Map(allowanceRows.map((r) => [key(r.userId, r.leaveTypeId, r.year), r]));
  const booked = new Map(bookedRows.map((r) => [key(r.userId, r.leaveTypeId, r.year), r]));
  const history = Map.groupBy(
    [...allowanceRows].sort((a, b) => b.year - a.year),
    (r) => `${r.userId}|${r.leaveTypeId}`,
  );
  /** The person's latest row for the type in `year` or before it. */
  const latestRow = (userId: string, leaveTypeId: string, year: number) =>
    history.get(`${userId}|${leaveTypeId}`)?.find((r) => r.year <= year);
  return {
    allowanceRow: (userId: string, leaveTypeId: string, year: number) => allowance.get(key(userId, leaveTypeId, year)),
    /** Whether the person has approved or pending days of the type in `year`. */
    hasBooked: (userId: string, leaveTypeId: string, year: number) => booked.has(key(userId, leaveTypeId, year)),
    latestRow,
    balance(policy: AllowancePolicy, leaveType: LeaveTypeAllowanceSettings & { id: string }, userId: string, year: number): Balance {
      const row = allowance.get(key(userId, leaveType.id, year));
      const record: AllowanceRecord | null = row
        ? { days: row.days, carriedOverDays: row.carriedOverDays, adjustmentDays: row.adjustmentDays }
        : null;
      const sums = booked.get(key(userId, leaveType.id, year)) ?? NOTHING_BOOKED;
      const carriedOut = allowance.get(key(userId, leaveType.id, year + 1))?.carriedOverDays ?? 0;
      return policy.balance({
        leaveType: { ...leaveType, defaultAllowanceDays: defaults(userId, leaveType) },
        allowance: record,
        inheritedDays: latestRow(userId, leaveType.id, year - 1)?.days ?? null,
        booked: { approved: sums.approved, pending: sums.pending },
        carriedOut,
      });
    },
  };
}

/**
 * Balances of many people, leave types and years at once, computed exactly as the
 * dashboard computes each one: two queries (allowance rows and booked-day sums, in
 * parallel), then pure lookups. For bulk checks such as the TimeOff import's
 * reconciliation.
 *
 * @returns A lookup by person, leave type (one of `leaveTypes`) and year (one of `years`).
 * @throws DomainError `policy_unavailable` when the policy is unknown.
 */
export async function loadBalances(
  ex: Executor,
  scope: {
    companyId: string;
    allowancePolicy: string;
    leaveTypes: readonly (LeaveTypeAllowanceSettings & { id: string })[];
    userIds: readonly string[];
    years: readonly number[];
  },
): Promise<(userId: string, leaveTypeId: string, year: number) => Balance> {
  const policy = resolveAllowancePolicy(scope.allowancePolicy);
  const leaveTypeIds = scope.leaveTypes.map((t) => t.id);
  const [allowanceRows, bookedRows, defaults] = await Promise.all([
    listAllowances(ex, { userIds: scope.userIds, years: allowanceYearsFor(scope.years), leaveTypeIds }),
    sumBookedDays(ex, { userIds: scope.userIds, years: scope.years, leaveTypeIds }),
    loadAllowanceDefaults(ex, scope.companyId, scope.userIds),
  ]);
  const inputs = balanceInputs(allowanceRows, bookedRows, defaults);
  const types = new Map(scope.leaveTypes.map((t) => [t.id, t]));
  return (userId, leaveTypeId, year) => {
    const type = types.get(leaveTypeId);
    if (!type) throw new Error(`Leave type ${leaveTypeId} was not loaded.`);
    return inputs.balance(policy, type, userId, year);
  };
}

/** A leave request checked against the calendar, the actor's other requests and their balance. */
export interface LeaveAssessment {
  range: LeaveRange;
  leaveType: { id: string; name: string };
  /** Total working days (half day = 0.5); always > 0. */
  days: number;
  /** Per calendar year, in order: the days charged and the balance before this request. */
  charges: PeriodCharge[];
}

/**
 * The single computation behind both the live preview and submitting a request, so
 * what the person is shown is exactly what submit will decide.
 *
 * In order: validates the range; requires an active leave type of the actor's
 * company; resolves the company's allowance policy; counts working days per year
 * (company working days, minus holidays); refuses a request worth nothing, one that
 * overlaps the actor's pending or approved time, and one a tracked balance cannot
 * cover in any year (pending requests, and days already carried into the next year,
 * count as spent).
 *
 * Read-only. Submit calls it inside its transaction after locking the requester, so
 * concurrent submits by one person see each other's days. `actor` is whoever the time
 * off is for: the person themself, or the one a manager or admin adds it for.
 *
 * @throws DomainError `invalid_input`, `invalid_date_range`, `range_too_long`,
 *   `half_day_multi_day`, `leave_type_unavailable`, `no_company`,
 *   `policy_unavailable`, `zero_days`, `overlapping_request` or
 *   `insufficient_balance` (with {@link BalanceShortfallDetails}).
 */
export async function assessLeaveRequest(
  ex: Executor,
  actor: Pick<Actor, "id" | "companyId">,
  draft: LeaveDraft,
): Promise<LeaveAssessment> {
  const range = draftRange(draft);
  assertValidRange(range);
  if (!isUuid(draft.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  // Independent reads, fetched together; the checks below keep their order.
  const [leaveType, settings, holidays, existing] = await Promise.all([
    findActiveLeaveType(ex, actor.companyId, draft.leaveTypeId),
    findCompanySettings(ex, actor.companyId),
    listHolidayDates(ex, actor.companyId, range.startDate, range.endDate),
    listActiveRequestsInRange(ex, actor.id, range.startDate, range.endDate),
  ]);
  if (!leaveType) throw new DomainError("leave_type_unavailable");
  if (!settings) throw new DomainError("no_company");
  const policy = resolveAllowancePolicy(settings.allowancePolicy);

  const split = policy.periodsFor(range, { workingDays: settings.workingDays, holidays });
  if (split.length === 0) {
    // Only on this path: name the holidays, so the person learns they needn't ask.
    throw new DomainError("zero_days", undefined, { holidays: await listHolidays(ex, actor.companyId, range.startDate, range.endDate) });
  }
  if (existing.some((other) => rangesOverlap(range, other))) throw new DomainError("overlapping_request");

  const years = split.map((s) => s.year);
  const [allowanceRows, bookedRows, defaults] = await Promise.all([
    listAllowances(ex, { userIds: [actor.id], years: allowanceYearsFor(years), leaveTypeIds: [leaveType.id] }),
    sumBookedDays(ex, { userIds: [actor.id], years, leaveTypeIds: [leaveType.id] }),
    loadAllowanceDefaults(ex, actor.companyId, [actor.id]),
  ]);
  const inputs = balanceInputs(allowanceRows, bookedRows, defaults);
  const charges = split.map(({ year, days }) => ({ year, days, before: inputs.balance(policy, leaveType, actor.id, year) }));
  assertCovered(charges);

  return {
    range,
    leaveType: { id: leaveType.id, name: leaveType.name },
    days: split.reduce((sum, s) => sum + s.days, 0),
    charges,
  };
}

/**
 * What a draft request would cost and leave, for the live preview. Runs exactly the
 * checks submit runs ({@link assessLeaveRequest}), without writing anything.
 *
 * @throws DomainError as {@link assessLeaveRequest}; the preview shows the message.
 */
export async function previewLeaveRequest(ctx: ServiceContext, actor: Actor, draft: LeaveDraft): Promise<RequestCost> {
  const assessment = await assessLeaveRequest(ctx.db, actor, draft);
  return {
    days: assessment.days,
    years: assessment.charges.map(({ year, days, before }) => ({ year, days, remainingAfter: remainingAfter(before, days) })),
  };
}

/** One leave type's balance, as the dashboard shows it. */
export interface BalanceSummaryItem {
  leaveTypeId: string;
  name: string;
  color: string;
  balance: Balance;
  /** The type is archived: no new requests, but its balance still shows where it has history. */
  archived: boolean;
  /** The person's own allowance row for the year, if they have one (admins edit it). */
  row: { days: number; carriedOverDays: number; adjustmentDays: number } | null;
}

export interface BalanceSummary {
  year: number;
  items: BalanceSummaryItem[];
}

/** Leave types (archived ones flagged) with their allowance settings, as {@link summarizeBalances} takes them. */
export type LeaveTypeWithAllowance = Awaited<ReturnType<typeof listLeaveTypesWithAllowance>>[number];

/**
 * {@link getBalanceSummary} for a caller that already loaded the company's settings
 * and leave types (the dashboard, an admin's view of a person): two queries, allowance
 * rows and booked-day sums (aggregated in SQL), in parallel, whatever the number of
 * types or requests.
 *
 * Every active type gets an item. An archived type gets one only when the person has
 * an allowance row or approved or pending days of it in the year, so retiring a type
 * never hides days already granted or used, and quietly drops it everywhere else.
 *
 * @throws DomainError `policy_unavailable`, before any query, when the policy is unknown.
 */
export async function summarizeBalances(
  ex: Executor,
  person: { id: string; companyId: string },
  loaded: { allowancePolicy: string; types: readonly LeaveTypeWithAllowance[]; year: number },
): Promise<BalanceSummary> {
  const policy = resolveAllowancePolicy(loaded.allowancePolicy);
  const { year } = loaded;
  const [allowanceRows, bookedRows, defaults] = await Promise.all([
    listAllowances(ex, { userIds: [person.id], years: allowanceYearsFor([year]) }),
    sumBookedDays(ex, { userIds: [person.id], years: [year] }),
    loadAllowanceDefaults(ex, person.companyId, [person.id]),
  ]);
  const inputs = balanceInputs(allowanceRows, bookedRows, defaults);
  return {
    year,
    items: loaded.types.flatMap((t) => {
      const row = inputs.allowanceRow(person.id, t.id, year);
      if (t.archived && !row && !inputs.hasBooked(person.id, t.id, year)) return [];
      return {
        leaveTypeId: t.id,
        name: t.name,
        color: t.color,
        archived: t.archived,
        balance: inputs.balance(policy, t, person.id, year),
        row: row ? { days: row.days, carriedOverDays: row.carriedOverDays, adjustmentDays: row.adjustmentDays } : null,
      };
    }),
  };
}

/**
 * The actor's balance for every active leave type in one year (plus archived types
 * they have history with, see {@link summarizeBalances}): by default the current year
 * in the company's time zone.
 *
 * Four queries whatever the number of types or requests: company settings and leave
 * types, then allowance rows and booked-day sums, each pair in parallel.
 *
 * @throws DomainError `no_company`, or `policy_unavailable` when the company's policy
 *   is unknown.
 */
export async function getBalanceSummary(ctx: ServiceContext, actor: Actor, year?: number): Promise<BalanceSummary> {
  const [settings, types] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    listLeaveTypesWithAllowance(ctx.db, actor.companyId),
  ]);
  if (!settings) throw new DomainError("no_company");
  return summarizeBalances(ctx.db, actor, {
    allowancePolicy: settings.allowancePolicy,
    types,
    year: year ?? yearInTimeZone(settings.timezone, ctx.now()),
  });
}
