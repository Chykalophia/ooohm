/**
 * A person's stored allowances and booked days, and the lookup that turns them into
 * balances. Pure: the rows come from the allowance repository.
 */
import type { AllowancePolicy, AllowanceRecord, Balance, BookedDays, LeaveTypeAllowanceSettings } from "./allowance-policy";
import type { AllowanceDefaults } from "./allowance-rules";

/** One person's allowance of one leave type for one year (an `allowances` row). */
export interface Allowance extends AllowanceRecord {
  id: string;
  userId: string;
  leaveTypeId: string;
  year: number;
}

/** A new allowance; carried-over and adjustment days start at 0 unless given. */
export interface NewAllowance {
  userId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  carriedOverDays?: number;
  adjustmentDays?: number;
}

/** Approved and pending days of one person, leave type and year. */
export interface BookedDaysOf extends BookedDays {
  userId: string;
  leaveTypeId: string;
  year: number;
}

/** Which balances to read: people, years and optionally leave types. */
export interface BalanceScope {
  userIds: readonly string[];
  years: readonly number[];
  /** Limit to these leave types; all types when omitted. */
  leaveTypeIds?: readonly string[];
}

const NOTHING_BOOKED: BookedDays = { approved: 0, pending: 0 };

/** The allowance years to load for balances of `years`: each year and the one after it. */
export function allowanceYearsFor(years: readonly number[]): number[] {
  return [...new Set(years.flatMap((y) => [y, y + 1]))];
}

/** The amounts of an allowance, as the policy reads them. */
export function allowanceRecord(row: AllowanceRecord): AllowanceRecord {
  return { days: row.days, carriedOverDays: row.carriedOverDays, adjustmentDays: row.adjustmentDays };
}

/**
 * Indexes allowance rows and booked-day sums by person, leave type and year, so many
 * balances can be computed from two queries.
 *
 * A year's balance counts the next year's `carried_over_days` as carried out of it,
 * and a type without a default inherits the person's latest earlier row. So
 * `allowanceRows` must cover each balance year and the year after it (see
 * {@link allowanceYearsFor}), plus the latest row before them, as the repository's
 * `list` returns them; a missing next-year row reads as nothing carried out.
 */
export function balanceInputs<A extends Allowance>(allowanceRows: readonly A[], bookedRows: readonly BookedDaysOf[], defaults: AllowanceDefaults) {
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
      const sums = booked.get(key(userId, leaveType.id, year)) ?? NOTHING_BOOKED;
      const carriedOut = allowance.get(key(userId, leaveType.id, year + 1))?.carriedOverDays ?? 0;
      return policy.balance({
        leaveType: { ...leaveType, defaultAllowanceDays: defaults(userId, leaveType) },
        allowance: row ? allowanceRecord(row) : null,
        inheritedDays: latestRow(userId, leaveType.id, year - 1)?.days ?? null,
        booked: { approved: sums.approved, pending: sums.pending },
        carriedOut,
      });
    },
  };
}

/** The lookup {@link balanceInputs} builds. */
export type BalanceInputs = ReturnType<typeof balanceInputs<Allowance>>;
