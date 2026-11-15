import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { isCalendarDate } from "@/shared/kernel/calendar-date";
import { DomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import { isCursorInstant, type PageCursor, readPage } from "@/shared/kernel/paging";
import { todayInTimeZone } from "@/lib/dates";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { canCancelOn } from "../../domain/leave-status";
import type { MyRequestsPageDTO } from "../dto";
import type { LeaveDeps } from "../ports";

/** Requests per page of "Your requests". */
export const REQUESTS_PAGE_SIZE = 10;

/** A requests page's key: `[start_date, created_at, id]`. */
const REQUEST_KEY = [isCalendarDate, isCursorInstant, isUuid] as const;

/**
 * A page of the actor's own requests for "Your requests", latest dates first, each with
 * whether it can be cancelled today ({@link canCancelOn}): the company (its time zone,
 * for today) and the page, in parallel.
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 * Fails with `no_company`.
 */
export async function listMyRequests(deps: LeaveDeps, actor: Actor, page?: PageCursor): Promise<ServiceResult<MyRequestsPageDTO>> {
  return attempt(async () => {
    const [settings, requests] = await Promise.all([
      deps.read.directory.companySettings(actor.companyId),
      readPage({
        cursor: page,
        size: REQUESTS_PAGE_SIZE,
        checks: REQUEST_KEY,
        read: (request, limit) => deps.read.requests.listOwn(actor.companyId, actor.id, limit, request),
        keyOf: (r) => [r.startDate, r.cursor, r.id],
      }),
    ]);
    if (!settings) throw new DomainError("no_company");
    const today = todayInTimeZone(settings.timezone, deps.clock.now());
    return {
      items: requests.items.map((r) => ({ ...r, cancellable: canCancelOn(r, today) })),
      previous: requests.previous,
      next: requests.next,
    };
  });
}
