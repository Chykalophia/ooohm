import type { Transaction } from "@/db/types";
import { type Actor, isAdmin } from "@/domain/actor";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { canDecide, decidesByAssignment } from "@/domain/leave-permissions";
import { normalizeNote } from "@/domain/leave-request";
import { type Overlap, overlapsFor } from "@/domain/overlap";
import { assertTransition } from "@/domain/request-status";
import type { ServiceContext } from "@/server/context";
import {
  countInbox,
  findLeaveRequest,
  type InboxScope,
  type LeaveRequestRow,
  listInbox,
  listRecentDecisions,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
import { findCompanySettings, listTeamEntries } from "@/server/repositories/calendar";
import { findLeaveType } from "@/server/repositories/leave-types";
import { findMember, listActiveAdmins } from "@/server/repositories/users";
import { teamLabel } from "@/domain/person";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify } from "./notify";

export type Decision = "approve" | "reject";

export interface DecideInput {
  requestId: string;
  decision: Decision;
  /** Optional reason, stored as `decision_note` and included in the requester's email. */
  reason?: string | null;
}

/** Most pending requests the inbox shows at once. */
const INBOX_LIMIT = 100;

/** How far back Settled reaches, and the most decisions it lists. */
const SETTLED_DAYS = 30;
const SETTLED_LIMIT = 50;

function scopeFor(actor: Actor): InboxScope {
  return { companyId: actor.companyId, deciderId: actor.id, isAdmin: isAdmin(actor) };
}

/**
 * Who the approval rule (minus self-approval) picks for `requesterId`'s pending
 * requests now, read inside `tx`: three reads at most.
 */
async function currentApprover(tx: Transaction, companyId: string, requesterId: string): Promise<string | null> {
  const [requester, admins] = await Promise.all([findMember(tx, companyId, requesterId), listActiveAdmins(tx, companyId)]);
  if (!requester) return null;
  const manager =
    requester.managerId && requester.managerId !== requester.id ? ((await findMember(tx, companyId, requester.managerId)) ?? null) : null;
  return reassignApprover(new ManagerApprovalRule(), { requester, manager, admins });
}

/**
 * Approves or rejects a pending request.
 *
 * The status change is a compare-and-set on `pending`, so when two people decide the
 * same request at once exactly one succeeds and the other gets `conflict`. A decision
 * that rests on the stored assignment ({@link decidesByAssignment}: a non-admin
 * approver, or an admin's own request routed to themself) first checks that the
 * approval rule still picks the actor, and its compare-and-set also requires the
 * request to still be assigned to them, so it loses to a concurrent reassignment.
 *
 * @throws DomainError `invalid_input` (reason too long), `not_found`, `forbidden`
 *   (neither an admin nor an assigned approver the rule still picks, or deciding one's
 *   own request), `invalid_transition` (no longer pending), or `conflict`.
 */
export async function decideLeaveRequest(ctx: ServiceContext, actor: Actor, input: DecideInput): Promise<LeaveRequestRow> {
  const reason = normalizeNote(input.reason);
  if (!isUuid(input.requestId)) throw new DomainError("not_found");
  if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("invalid_input");
  const to = input.decision === "approve" ? "approved" : "rejected";

  return commitThenNotify(ctx, async (tx) => {
    const before = await findLeaveRequest(tx, actor.companyId, input.requestId);
    if (!before) throw new DomainError("not_found");
    const byAssignment = decidesByAssignment(actor, before);
    const current = byAssignment && before.approverId === actor.id ? await currentApprover(tx, actor.companyId, before.userId) : null;
    if (!canDecide(actor, before, current)) throw new DomainError("forbidden");
    assertTransition(before.status, to);

    const after = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: before.id, from: "pending", approverId: byAssignment ? actor.id : undefined },
      { status: to, decidedAt: ctx.now(), decisionNote: reason },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: to, before, after, source: actor.source });

    const contacts = await activeContacts(tx, actor.companyId, [after.userId]);
    const requester = contacts.get(after.userId);
    if (!requester) return { result: after, outgoing: [] };
    const leaveType = await findLeaveType(tx, actor.companyId, after.leaveTypeId);
    const leave = summarize(after, requester, leaveType?.name ?? "Time off");
    const link = `${ctx.appUrl}/`;
    const email = { kind: to, recipientName: requester.name, leave, reason, link } as const;
    return { result: after, outgoing: [{ to: requester.email, email }] };
  });
}

/**
 * Pending requests the actor can decide: those assigned to them and, for admins,
 * every other pending request in the company. Earliest start date first.
 *
 * @param limit Most items to return; defaults to {@link INBOX_LIMIT}.
 * @returns At most `limit` `items`, and the `total` waiting, which is larger than
 *   `items.length` only when the list was cut. The count query runs only in that case.
 */
export async function listApprovalInbox(ctx: ServiceContext, actor: Actor, limit = INBOX_LIMIT) {
  const scope = scopeFor(actor);
  const items = await listInbox(ctx.db, scope, limit);
  const total = items.length < limit ? items.length : await countInbox(ctx.db, scope);
  return { items, total };
}

/**
 * Whether the header shows the Approvals link, and how many requests wait there.
 * Managers and admins always see it; anyone else only while something is assigned
 * to them.
 */
export async function getApprovalNav(ctx: ServiceContext, actor: Actor): Promise<{ visible: boolean; pending: number }> {
  const pending = await countInbox(ctx.db, scopeFor(actor));
  return { visible: actor.role !== "employee" || pending > 0, pending };
}

type InboxItem = Awaited<ReturnType<typeof listInbox>>[number];

/** A pending request on the Approvals page, with who else is off on its dates. */
export type TriageItem = InboxItem & { overlaps: Overlap[] };

/** One tab's pending requests: at most {@link INBOX_LIMIT}, and how many there are in all. */
async function inboxPart(ctx: ServiceContext, scope: InboxScope) {
  const items = await listInbox(ctx.db, scope, INBOX_LIMIT);
  const total = items.length < INBOX_LIMIT ? items.length : await countInbox(ctx.db, scope);
  return { items, total };
}

/**
 * The Approvals page, sorted by whose move it is:
 *
 * - `needsYou`: pending requests assigned to the actor, plus (for admins) any with no
 *   approver, since only an admin can decide those.
 * - `waiting`: pending requests an admin may decide but that are assigned to someone
 *   else. Always empty for a non-admin.
 * - `settled`: requests the actor approved or declined in the last {@link SETTLED_DAYS}
 *   days, newest first, at most {@link SETTLED_LIMIT}.
 *
 * `needsYou` and `waiting` are read separately, each capped at {@link INBOX_LIMIT} with
 * its own `total`, so a long queue for other approvers never pushes the actor's own
 * requests out of view.
 *
 * Each pending item carries who else is off on its dates ({@link overlapsFor}): the
 * requester's department, or everyone when they have none. That is what the team
 * calendar shows every member (labelled the same way), so it reveals nothing new. At
 * most seven queries: the two tabs, the decisions and the company's time zone in
 * parallel, a count for each tab that was cut, then one team-calendar range over the
 * pending dates.
 */
export async function getApprovalTriage(ctx: ServiceContext, actor: Actor) {
  const scope = scopeFor(actor);
  const since = new Date(ctx.now().getTime() - SETTLED_DAYS * 86_400_000);
  const none = { items: [] as InboxItem[], total: 0 };
  const [mine, others, settled, settings] = await Promise.all([
    inboxPart(ctx, { ...scope, part: "mine" }),
    scope.isAdmin ? inboxPart(ctx, { ...scope, part: "others" }) : Promise.resolve(none),
    listRecentDecisions(ctx.db, { companyId: actor.companyId, deciderId: actor.id, since }, SETTLED_LIMIT),
    findCompanySettings(ctx.db, actor.companyId),
  ]);

  const pending = [...mine.items, ...others.items];
  let withOverlaps = (items: InboxItem[]): TriageItem[] => items.map((item) => ({ ...item, overlaps: [] }));
  if (pending.length > 0) {
    const from = pending.reduce((min, i) => (i.startDate < min ? i.startDate : min), "9999-12-31");
    const to = pending.reduce((max, i) => (i.endDate > max ? i.endDate : max), "0000-01-01");
    const leave = (await listTeamEntries(ctx.db, actor.companyId, from, to)).map((e) => ({
      ...e,
      personName: teamLabel({ name: e.personName, email: e.personEmail }),
    }));
    withOverlaps = (items) =>
      items.map((item) => ({
        ...item,
        overlaps: overlapsFor(
          { requesterId: item.requesterId, departmentId: item.requesterDepartmentId, startDate: item.startDate, endDate: item.endDate },
          leave,
        ),
      }));
  }

  return {
    needsYou: withOverlaps(mine.items),
    needsYouTotal: mine.total,
    waiting: withOverlaps(others.items),
    waitingTotal: others.total,
    settled: settled.map((d) => ({ ...d, decision: d.action === "leave_request.approved" ? ("approved" as const) : ("rejected" as const) })),
    /** Everything pending that the actor may decide, as the header counts it. */
    total: mine.total + others.total,
    settledDays: SETTLED_DAYS,
    timeZone: settings?.timezone ?? "UTC",
  };
}
