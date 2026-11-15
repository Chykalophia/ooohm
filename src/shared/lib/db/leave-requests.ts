import "server-only";
/**
 * Reads of leave requests that modules below leave need (balances counts booked days,
 * calendar asks whether someone has approved time off). Leave owns the table and
 * imports those modules, so the reads sit here rather than behind leave's index.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { leaveRequests } from "@/db/schema";
import type { Executor } from "@/db/types";

/** The requester's pending/approved requests whose dates intersect `[from, to]`. */
export async function listActiveRequestsInRange(ex: Executor, userId: string, from: string, to: string) {
  return ex
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.userId, userId),
        inArray(leaveRequests.status, ["pending", "approved"]),
        lte(leaveRequests.startDate, to),
        gte(leaveRequests.endDate, from),
      ),
    );
}

/**
 * Whether the person has time off approved in this company right now, however far back
 * its dates are. A request that was approved and later cancelled doesn't count: it put
 * nothing in a calendar.
 */
export async function hasApprovedRequest(ex: Executor, companyId: string, userId: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), eq(leaveRequests.status, "approved")))
    .limit(1);
  return row !== undefined;
}

