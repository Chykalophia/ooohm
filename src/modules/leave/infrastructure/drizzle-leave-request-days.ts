import "server-only";
/** What each leave request costs per calendar year (`leave_request_days`), which leave writes. */
import { eq, inArray } from "drizzle-orm";
import { leaveRequestDays } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { YearDays } from "@/shared/kernel/leave-days";

/** Stores what a just-created request costs in each year. Every entry must have `days > 0`. */
export async function insertRequestDays(tx: Transaction, requestId: string, split: readonly YearDays[]): Promise<void> {
  if (split.length === 0) return;
  await tx.insert(leaveRequestDays).values(split.map(({ year, days }) => ({ requestId, year, days })));
}

/** The stored per-year split of each request, by request id, ordered by year. */
export async function listRequestDays(ex: Executor, requestIds: readonly string[]): Promise<Map<string, YearDays[]>> {
  const split = new Map<string, YearDays[]>();
  if (requestIds.length === 0) return split;
  const rows = await ex
    .select({ requestId: leaveRequestDays.requestId, year: leaveRequestDays.year, days: leaveRequestDays.days })
    .from(leaveRequestDays)
    .where(inArray(leaveRequestDays.requestId, [...requestIds]))
    .orderBy(leaveRequestDays.requestId, leaveRequestDays.year);
  for (const { requestId, year, days } of rows) {
    const list = split.get(requestId) ?? [];
    list.push({ year, days });
    split.set(requestId, list);
  }
  return split;
}

/** Replaces a request's per-year split. Every entry must have `days > 0`. */
export async function replaceRequestDays(tx: Transaction, requestId: string, split: readonly YearDays[]): Promise<void> {
  await tx.delete(leaveRequestDays).where(eq(leaveRequestDays.requestId, requestId));
  await insertRequestDays(tx, requestId, split);
}
