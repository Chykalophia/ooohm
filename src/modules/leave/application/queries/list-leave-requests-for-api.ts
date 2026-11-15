import "server-only";
import type { CalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { type ApiClient, assertScope } from "@/domain/integrations";
import { decodeCursor, iso, type Page, page } from "@/server/services/api-v1";
import type { LeaveStatus } from "@/shared/kernel/leave-range";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import type { LeaveDeps } from "../ports";

export interface LeaveRequestQuery {
  from?: CalendarDate;
  to?: CalendarDate;
  userId?: string;
  status?: LeaveStatus;
  cursor?: string;
  limit: number;
}

/** A leave request as the REST API returns it: never a note, times as ISO strings. */
export interface ApiLeaveRequestDTO {
  id: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: "full" | "am" | "pm";
  days: number;
  status: LeaveStatus;
  approverId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Leave requests overlapping `[from, to]` (either bound optional), optionally one
 * person's or one status, by start date then id. One query.
 *
 * Fails with `forbidden` (no `read` scope) or `invalid_input` for a bad cursor or `to` before `from`.
 */
export async function listLeaveRequestsForApi(deps: LeaveDeps, client: ApiClient, q: LeaveRequestQuery): Promise<ServiceResult<Page<ApiLeaveRequestDTO>>> {
  return attempt(async () => {
    assertScope(client, "read");
    if (q.from && q.to && q.to < q.from) throw new DomainError("invalid_input", "`to` is before `from`.");
    let after: { startDate: string; id: string } | undefined;
    if (q.cursor) {
      const c = decodeCursor(q.cursor, ["s", "i"]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c.s) || !isUuid(c.i)) throw new DomainError("invalid_input", "That cursor is not valid.");
      after = { startDate: c.s, id: c.i };
    }
    const rows = await deps.read.requests.pageForApi({ companyId: client.companyId, ...q, after });
    return page(
      rows,
      q.limit,
      (r) => ({
        id: r.id,
        userId: r.userId,
        leaveTypeId: r.leaveTypeId,
        startDate: r.startDate,
        endDate: r.endDate,
        dayPortion: r.dayPortion,
        days: r.days,
        status: r.status,
        approverId: r.approverId,
        decidedAt: iso(r.decidedAt),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }),
      (r) => ({ s: r.startDate, i: r.id }),
    );
  });
}
