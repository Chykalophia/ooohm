import { and, eq, inArray, lt, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { allowances, leaveRequestDays, leaveRequests } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { YearDays } from "@/domain/leave-days";

export type AllowanceRow = typeof allowances.$inferSelect;
export type NewAllowance = typeof allowances.$inferInsert;

/** Stores what a just-created request costs in each year. Every entry must have `days > 0`. */
export async function insertRequestDays(tx: Transaction, requestId: string, split: readonly YearDays[]): Promise<void> {
  if (split.length === 0) return;
  await tx.insert(leaveRequestDays).values(split.map(({ year, days }) => ({ requestId, year, days })));
}

/** Which balances to read: people, years and optionally leave types. */
export interface BalanceScope {
  userIds: readonly string[];
  years: readonly number[];
  /** Limit to these leave types; all types when omitted. */
  leaveTypeIds?: readonly string[];
}

function scopeIsEmpty(scope: BalanceScope): boolean {
  return scope.userIds.length === 0 || scope.years.length === 0 || scope.leaveTypeIds?.length === 0;
}

/**
 * Approved and pending days per person, leave type and year, summed in SQL from the
 * stored per-year splits. One query whatever the number of requests. Combinations
 * with nothing booked are absent.
 */
export async function sumBookedDays(ex: Executor, scope: BalanceScope) {
  if (scopeIsEmpty(scope)) return [];
  return ex
    .select({
      userId: leaveRequests.userId,
      leaveTypeId: leaveRequests.leaveTypeId,
      year: leaveRequestDays.year,
      approved: sql<number>`coalesce(sum(${leaveRequestDays.days}) filter (where ${leaveRequests.status} = 'approved'), 0)`.mapWith(Number),
      pending: sql<number>`coalesce(sum(${leaveRequestDays.days}) filter (where ${leaveRequests.status} = 'pending'), 0)`.mapWith(Number),
    })
    .from(leaveRequestDays)
    .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
    .where(
      and(
        inArray(leaveRequests.userId, [...scope.userIds]),
        inArray(leaveRequestDays.year, [...scope.years]),
        inArray(leaveRequests.status, ["approved", "pending"]),
        scope.leaveTypeIds ? inArray(leaveRequests.leaveTypeId, [...scope.leaveTypeIds]) : undefined,
      ),
    )
    .groupBy(leaveRequests.userId, leaveRequests.leaveTypeId, leaveRequestDays.year);
}

const earlier = alias(allowances, "earlier");

/**
 * Allowance rows in scope, plus, for each person and leave type, their latest row
 * before the earliest year in scope (the row a type without a default inherits from).
 * One query, served by the (user, type, year) unique index.
 */
export async function listAllowances(ex: Executor, scope: BalanceScope): Promise<AllowanceRow[]> {
  if (scopeIsEmpty(scope)) return [];
  const firstYear = Math.min(...scope.years);
  const latestEarlierYear = ex
    .select({ year: max(earlier.year) })
    .from(earlier)
    .where(
      and(eq(earlier.userId, allowances.userId), eq(earlier.leaveTypeId, allowances.leaveTypeId), lt(earlier.year, firstYear)),
    );
  return ex
    .select()
    .from(allowances)
    .where(
      and(
        inArray(allowances.userId, [...scope.userIds]),
        or(inArray(allowances.year, [...scope.years]), eq(allowances.year, latestEarlierYear)),
        scope.leaveTypeIds ? inArray(allowances.leaveTypeId, [...scope.leaveTypeIds]) : undefined,
      ),
    );
}

/**
 * Inserts allowance rows that do not exist yet; existing rows (same person, type and
 * year) are left untouched.
 *
 * @returns Only the rows this call created.
 */
export async function insertMissingAllowances(tx: Transaction, rows: readonly NewAllowance[]): Promise<AllowanceRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(allowances)
    .values([...rows])
    .onConflictDoNothing({ target: [allowances.userId, allowances.leaveTypeId, allowances.year] })
    .returning();
}

export async function setCarriedOverDays(tx: Transaction, id: string, carriedOverDays: number): Promise<AllowanceRow> {
  const [row] = await tx.update(allowances).set({ carriedOverDays }).where(eq(allowances.id, id)).returning();
  return row;
}

/** A person's allowance row for one leave type and year, if any. */
export async function findAllowance(
  ex: Executor,
  where: { userId: string; leaveTypeId: string; year: number },
): Promise<AllowanceRow | undefined> {
  const [row] = await ex
    .select()
    .from(allowances)
    .where(and(eq(allowances.userId, where.userId), eq(allowances.leaveTypeId, where.leaveTypeId), eq(allowances.year, where.year)));
  return row;
}

/**
 * Writes an admin's override: `days` and `adjustmentDays` only. A new row starts with
 * nothing carried over; an existing row keeps its `carried_over_days`, which belongs
 * to the year rollover.
 */
export async function writeAllowanceOverride(
  tx: Transaction,
  values: { userId: string; leaveTypeId: string; year: number; days: number; adjustmentDays: number },
): Promise<AllowanceRow> {
  const [row] = await tx
    .insert(allowances)
    .values(values)
    .onConflictDoUpdate({
      target: [allowances.userId, allowances.leaveTypeId, allowances.year],
      set: { days: values.days, adjustmentDays: values.adjustmentDays },
    })
    .returning();
  return row;
}
