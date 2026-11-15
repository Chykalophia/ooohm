/**
 * The allowance policy engine: how much leave a person has, and what a request costs
 * against it.
 *
 * {@link AllowancePolicy} is a Strategy. A company names its policy in
 * `companies.allowance_policy`; code looks it up with `resolveAllowancePolicy`
 * (`policy-registry.ts`) and never branches on the key itself. v1 ships one policy,
 * `AnnualCalendarYearPolicy`. Balance periods are identified by a year number, which is
 * also how per-request costs are stored (`leave_request_days.year`).
 */
import { DomainError, type BalanceShortfallDetails } from "@/domain/errors";
import { addDays } from "@/shared/kernel/day-amounts";
import type { WorkCalendar, YearDays } from "@/shared/kernel/leave-days";
import type { LeaveRange } from "@/shared/kernel/leave-range";

/** A leave type's settings that decide whether and how it is tracked. */
export interface LeaveTypeAllowanceSettings {
  /** When false the type is never limited, whatever allowance rows exist. */
  countsAgainstAllowance: boolean;
  /**
   * Yearly allowance for anyone without their own allowance row. Null = no default:
   * the type is untracked for a person until they get their first row.
   */
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  /** Most days carried into the next year. Null = no cap. */
  carryoverMaxDays: number | null;
}

/** A person's stored allowance for one leave type and year (`allowances` row). */
export interface AllowanceRecord {
  days: number;
  carriedOverDays: number;
  adjustmentDays: number;
}

/** Days already booked against one leave type in one year, by status. */
export interface BookedDays {
  approved: number;
  pending: number;
}

/**
 * A balance for one leave type in one period.
 *
 * Untracked types (unlimited) report what was used and is pending, but have no
 * allowance and no remaining, and never block a request.
 */
export type Balance =
  | {
      tracked: true;
      /** The period's base allowance: the person's row, else the type's default. */
      allowance: number;
      carriedOver: number;
      adjustment: number;
      /** allowance + carriedOver + adjustment. */
      total: number;
      /** Approved days. */
      used: number;
      pending: number;
      /**
       * Days the year rollover already carried out of this period into the next one
       * (the next period's `carried_over_days`). They count as spent here, so the same
       * days cannot be booked in both periods.
       */
      carriedOut: number;
      /**
       * total - used - pending - carriedOut. Negative when an allowance was lowered
       * after booking.
       */
      remaining: number;
    }
  | { tracked: false; used: number; pending: number };

export interface BalanceInput {
  leaveType: LeaveTypeAllowanceSettings;
  /** The person's allowance row for the period, if one exists. */
  allowance: AllowanceRecord | null;
  /**
   * `days` of the person's latest allowance row for an earlier period, if any. Only a
   * type without a default uses it, and only when the period has no row of its own.
   */
  inheritedDays?: number | null;
  booked: BookedDays;
  /** Days already carried out of this period into the next one; 0 when omitted. */
  carriedOut?: number;
}

/** A pluggable allowance policy. Implementations are pure and stateless. */
export interface AllowancePolicy {
  /** The `companies.allowance_policy` value this policy answers to. */
  readonly key: string;
  /** The balance periods a request draws from, and what it costs in each (all > 0). */
  periodsFor(range: LeaveRange, calendar: WorkCalendar): YearDays[];
  balance(input: BalanceInput): Balance;
  /**
   * Days to carry from a closed period's balance into the next one, or `null` when
   * the type carries nothing (carryover off, or not tracked).
   */
  carryover(leaveType: LeaveTypeAllowanceSettings, closing: Balance): number | null;
}

/** What a request costs in one period, against the balance before it. */
export interface PeriodCharge {
  year: number;
  days: number;
  before: Balance;
}

/**
 * What a request would cost, as the live preview shows it: the total, and per year
 * the days charged and the balance left afterwards (`null` for an untracked type).
 */
export interface RequestCost {
  days: number;
  years: { year: number; days: number; remainingAfter: number | null }[];
}

/**
 * A tracked balance with nothing in it: no days allotted (allowance, carryover and
 * adjustment add up to 0) and none used, pending or carried out. A balance that is
 * overdrawn or has any booking is never empty.
 */
export function isEmptyBalance(b: Balance): boolean {
  return b.tracked && b.total === 0 && b.used === 0 && b.pending === 0 && b.carriedOut === 0;
}

/** The balance left in a period once `days` more are booked; `null` when untracked. */
export function remainingAfter(before: Balance, days: number): number | null {
  return before.tracked ? addDays(before.remaining, -days) : null;
}

/**
 * The first period a request overdraws, if any. Pending requests already count as
 * spent in `before`, so two pending requests cannot promise the same days twice.
 * Untracked balances never fall short.
 */
export function findShortfall(charges: readonly PeriodCharge[]): BalanceShortfallDetails | null {
  for (const { year, days, before } of charges) {
    if (before.tracked && days > before.remaining) {
      return { year, requested: days, remaining: before.remaining, yearsSpanned: charges.length };
    }
  }
  return null;
}

/**
 * @throws DomainError `insufficient_balance`, with the shortfall as `details`, when
 *   {@link findShortfall} finds one.
 */
export function assertCovered(charges: readonly PeriodCharge[]): void {
  const shortfall = findShortfall(charges);
  if (shortfall) {
    throw new DomainError(
      "insufficient_balance",
      `Requested ${shortfall.requested} days in ${shortfall.year} with ${shortfall.remaining} left.`,
      shortfall,
    );
  }
}
