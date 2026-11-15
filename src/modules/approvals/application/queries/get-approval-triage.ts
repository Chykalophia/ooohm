import "server-only";
import { type Actor, isAdmin } from "@/shared/kernel/actor";
import { isCalendarDate } from "@/shared/kernel/calendar-date";
import { isUuid } from "@/shared/kernel/uuid";
import { isCursorInstant, type PageCursor, readPage } from "@/shared/kernel/paging";
import type { ApprovalsView, ApprovalTriageDTO } from "../dto";
import type { ApprovalDeps, InboxScope } from "../ports";

/** Requests per page of the inbox: each comes with its own decision form. */
export const INBOX_PAGE_SIZE = 10;

/** An inbox page's key: `[start_date, created_at, id]`. */
const INBOX_KEY = [isCalendarDate, isCursorInstant, isUuid] as const;

/** How far back Settled reaches. */
export const SETTLED_DAYS = 30;

/** A Settled page's key: the audit row's `[created_at, id]`. */
const SETTLED_KEY = [isCursorInstant, isUuid] as const;

export function inboxScopeFor(actor: Actor): InboxScope {
  return { companyId: actor.companyId, deciderId: actor.id, isAdmin: isAdmin(actor) };
}

type TriageBase = Pick<ApprovalTriageDTO, "view" | "needsYouTotal" | "waitingTotal" | "settledDays" | "timeZone">;
type Paging = { page?: PageCursor | undefined; size: number };

/**
 * The Approvals page, sorted by whose move it is, one tab at a time:
 *
 * - `mine` (Needs you): pending requests assigned to the actor, plus (for admins) any with
 *   no approver, since only an admin can decide those.
 * - `others` (Waiting on others): pending requests an admin may decide but that are
 *   assigned to someone else. Never anything for a non-admin.
 * - `settled`: requests the actor approved or declined in the last {@link SETTLED_DAYS}
 *   days, newest first (read from the audit log, so an
 *   admin's override counts as theirs; self-approvals are left out).
 *
 * Every tab is paged ({@link INBOX_PAGE_SIZE} a page; the pending ones earliest dates first);
 * deciding a request takes it off its tab, so the same page shows the next ones in its
 * place. Each pending request carries `alsoOff`, who else is off on its dates. Both
 * pending tabs are counted every time, for their labels (and to hide Waiting when it is empty).
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 */
export async function getApprovalTriage(
  deps: ApprovalDeps,
  actor: Actor,
  { view = "mine", page, size = INBOX_PAGE_SIZE }: { view?: ApprovalsView | undefined; page?: PageCursor | undefined; size?: number | undefined } = {},
): Promise<ApprovalTriageDTO> {
  const scope = inboxScopeFor(actor);
  const tab: ApprovalsView = view === "others" && !scope.isAdmin ? "mine" : view;
  const [needsYouTotal, waitingTotal, timeZone] = await Promise.all([
    deps.read.inbox.count({ ...scope, part: "mine" }),
    scope.isAdmin ? deps.read.inbox.count({ ...scope, part: "others" }) : Promise.resolve(0),
    deps.read.directory.timezone(actor.companyId),
  ]);
  const base: TriageBase = { view: tab, needsYouTotal, waitingTotal, settledDays: SETTLED_DAYS, timeZone: timeZone ?? "UTC" };
  if (tab === "settled") return settledTab(deps, actor, base, { page, size });
  return pendingTab(deps, actor, { ...scope, part: tab }, base, { page, size });
}

async function settledTab(deps: ApprovalDeps, actor: Actor, base: TriageBase, { page, size }: Paging): Promise<ApprovalTriageDTO> {
  const since = new Date(deps.now().getTime() - SETTLED_DAYS * 86_400_000);
  const decisions = await readPage({
    cursor: page,
    size,
    checks: SETTLED_KEY,
    read: (request, limit) => deps.read.inbox.recentDecisions({ companyId: actor.companyId, deciderId: actor.id, since }, limit, request),
    keyOf: (d) => [d.cursor, d.auditId],
  });
  const settled = decisions.items.map((d) => ({
    ...d,
    decision: d.action === "leave_request.approved" ? ("approved" as const) : ("rejected" as const),
  }));
  return { ...base, items: [], previous: decisions.previous, next: decisions.next, settled };
}

async function pendingTab(deps: ApprovalDeps, actor: Actor, scope: InboxScope, base: TriageBase, { page, size }: Paging): Promise<ApprovalTriageDTO> {
  const inbox = await readPage({
    cursor: page,
    size,
    checks: INBOX_KEY,
    read: (request, limit) => deps.read.inbox.list(scope, limit, request),
    keyOf: (r) => [r.startDate, r.cursor, r.id],
  });
  const alsoOff = await deps.read.inbox.alsoOff(
    actor.companyId,
    inbox.items.map((r) => ({
      id: r.id,
      userId: r.requesterId,
      departmentId: r.requesterDepartmentId,
      departmentName: r.requesterDepartmentName,
      startDate: r.startDate,
      endDate: r.endDate,
    })),
    actor.id,
  );
  const items = inbox.items.map((r) => ({ ...r, alsoOff: alsoOff.get(r.id) ?? null }));
  return { ...base, items, previous: inbox.previous, next: inbox.next, settled: [] };
}
