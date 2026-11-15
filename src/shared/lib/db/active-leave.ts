import "server-only";
import { and, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { leaveRequests } from "@/db/schema";
import { ACTIVE_STATUSES, earliestOverlappingStart } from "@/shared/kernel/leave-range";

/**
 * Pending or approved requests of the company whose dates intersect `[from, to]`.
 *
 * `end_date >= from` cannot bound a scan of `(company_id, start_date, end_date)`, so on
 * its own the scan would read the company's whole history before `to`. A request spans
 * at most `MAX_REQUEST_SPAN_DAYS` days (the `leave_requests_span_max` check), so
 * one that reaches `from` starts no earlier than {@link earliestOverlappingStart}: that
 * bound makes the index range two-sided.
 */
export function activeInRange(companyId: string, from: string, to: string): SQL | undefined {
  return and(
    eq(leaveRequests.companyId, companyId),
    inArray(leaveRequests.status, [...ACTIVE_STATUSES]),
    gte(leaveRequests.startDate, earliestOverlappingStart(from)),
    lte(leaveRequests.startDate, to),
    gte(leaveRequests.endDate, from),
  );
}
