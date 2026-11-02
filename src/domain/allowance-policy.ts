/**
 * The allowance policy engine: how much leave a person has, and what a request costs
 * against it.
 *
 * A company names its policy in `companies.allowance_policy`; services look it up with
 * {@link resolveAllowancePolicy} and never branch on the key themselves. v1 ships one
 * policy, {@link AnnualCalendarYearPolicy}. Balance periods are identified by a year
 * number, which is also how per-request costs are stored (`leave_request_days.year`).
 */
import { DomainError, type BalanceShortfallDetails } from "./errors";
import { splitLeaveDaysByYear, type WorkCalendar, type YearDays } from "./leave-days";
import type { LeaveRange } from "./leave-request";

/** The policy key v1 ships, and the column default. */
export const ANNUAL_CALENDAR_YEAR = "annual_calendar_year";

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

/**
 * Adds day amounts in tenths, so 0.1 + 0.2 is 0.3. Every stored amount is
 * `numeric(5,1)`, so tenths are exact.
 */
export function addDays(...amounts: number[]): number {
  return amounts.reduce((sum, n) => sum + Math.round(n * 10), 0) / 10;
}

/**
 * v1 policy: a flat yearly allowance per leave type, reset on Jan 1.
 *
 * - A type is tracked when it counts against allowance and the person has an
 *   allowance row for the year, or the type has a default allowance, or (no default)
 *   the person has a row for an earlier year.
 * - allowance = the row's `days`, else the type's default, else the `days` of the
 *   person's latest earlier row. Without that last step a type with no default would
 *   turn unlimited in any year the rollover had not yet given a row (booking ahead,
 *   or the January part of a request over New Year). Carryover and adjustment come
 *   from the year's own row (0 without one).
 * - used = approved days in the year; pending = pending days in the year; both read
 *   from each request's stored per-year split, so a request over New Year counts in
 *   each year separately.
 * - remaining = total - used - pending - carriedOut, where carriedOut is what the
 *   rollover already moved into the next year. Without it, leave booked late into a
 *   closed year could spend days that were also carried forward.
 * - Carryover: when enabled, the closing year's remaining before any carry (remaining
 *   + carriedOut), clamped to `[0, carryoverMaxDays]` (no upper bound when the max is
 *   null).
 */
export class AnnualCalendarYearPolicy implements AllowancePolicy {
  readonly key = ANNUAL_CALENDAR_YEAR;

  periodsFor(range: LeaveRange, calendar: WorkCalendar): YearDays[] {
    return splitLeaveDaysByYear(range, calendar);
  }

  balance({ leaveType, allowance, inheritedDays = null, booked, carriedOut: out = 0 }: BalanceInput): Balance {
    const used = addDays(booked.approved);
    const pending = addDays(booked.pending);
    const base = allowance?.days ?? leaveType.defaultAllowanceDays ?? inheritedDays;
    if (!leaveType.countsAgainstAllowance || base === null) return { tracked: false, used, pending };

    const carriedOver = allowance?.carriedOverDays ?? 0;
    const adjustment = allowance?.adjustmentDays ?? 0;
    const total = addDays(base, carriedOver, adjustment);
    const carriedOut = addDays(out);
    return {
      tracked: true,
      allowance: addDays(base),
      carriedOver: addDays(carriedOver),
      adjustment: addDays(adjustment),
      total,
      used,
      pending,
      carriedOut,
      remaining: addDays(total, -used, -pending, -carriedOut),
    };
  }

  carryover(leaveType: LeaveTypeAllowanceSettings, closing: Balance): number | null {
    if (!leaveType.carryoverEnabled || !closing.tracked) return null;
    // What was left before any carry, so recomputing over an earlier carry is stable.
    const floor = Math.max(addDays(closing.remaining, closing.carriedOut), 0);
    return leaveType.carryoverMaxDays === null ? floor : Math.min(floor, addDays(leaveType.carryoverMaxDays));
  }
}

const POLICIES: ReadonlyMap<string, AllowancePolicy> = new Map(
  [new AnnualCalendarYearPolicy()].map((policy) => [policy.key, policy]),
);

/** Every registered policy key, for the company settings form and its validation. */
export const ALLOWANCE_POLICY_KEYS: readonly string[] = [...POLICIES.keys()];

/**
 * The policy a company is configured with.
 *
 * @throws DomainError `policy_unavailable` for a key no policy answers to. Falling
 *   back to a default would quietly compute wrong balances, so this fails instead.
 */
export function resolveAllowancePolicy(key: string): AllowancePolicy {
  const policy = POLICIES.get(key);
  if (!policy) throw new DomainError("policy_unavailable", `Unknown allowance policy "${key}".`);
  return policy;
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
