import "server-only";
import { and, asc, eq, gte, inArray, lt, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { allowances, leaveRequestDays, leaveRequests } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { AllowanceRepository } from "../application/ports";
import type { BalanceScope } from "../domain/allowance";

export type AllowanceRow = typeof allowances.$inferSelect;
export type NewAllowance = typeof allowances.$inferInsert;

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

/** The allowance rows of `userIds` for `fromYear` and later, optionally of some leave types only, locked until commit. */
export async function lockAllowancesFrom(
  tx: Transaction,
  scope: { userIds: readonly string[]; fromYear: number; leaveTypeIds?: readonly string[] },
): Promise<AllowanceRow[]> {
  if (scope.userIds.length === 0 || scope.leaveTypeIds?.length === 0) return [];
  return tx
    .select()
    .from(allowances)
    .where(
      and(
        inArray(allowances.userId, [...scope.userIds]),
        gte(allowances.year, scope.fromYear),
        scope.leaveTypeIds ? inArray(allowances.leaveTypeId, [...scope.leaveTypeIds]) : undefined,
      ),
    )
    .orderBy(asc(allowances.userId), asc(allowances.leaveTypeId), asc(allowances.year))
    .for("update");
}

export async function setAllowanceDays(tx: Transaction, id: string, days: number): Promise<AllowanceRow> {
  const [row] = await tx.update(allowances).set({ days }).where(eq(allowances.id, id)).returning();
  return row;
}

/** The {@link AllowanceRepository} on Drizzle, bound to `ex` (writes need a transaction). */
export function drizzleAllowanceRepository(ex: Executor): AllowanceRepository {
  const tx = ex as Transaction;
  return {
    list: (scope) => listAllowances(ex, scope),
    sumBooked: (scope) => sumBookedDays(ex, scope),
    find: (where) => findAllowance(ex, where),
    insertMissing: (rows) => insertMissingAllowances(tx, rows),
    setCarriedOverDays: (id, days) => setCarriedOverDays(tx, id, days),
    setDays: (id, days) => setAllowanceDays(tx, id, days),
    writeOverride: (values) => writeAllowanceOverride(tx, values),
    lockFrom: (scope) => lockAllowancesFrom(tx, scope),
  };
}
