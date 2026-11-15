import "server-only";
/** Re-routing pending requests when an admin change moves the right to decide them. */
import type { Actor } from "@/domain/actor";
import { type LeaveRequest, summarize } from "@/modules/leave";
import type { Notification } from "@/modules/notifications";
import { approverFor } from "../domain/approver-for";
import { approveLinkFor } from "./approve-link";
import type { ApprovalDeps, ApprovalStore } from "./ports";

type Move = { request: LeaveRequest; approverId: string | null };

/** What a re-route did: how many requests moved, and the review emails to send after commit. */
export interface Rerouted {
  reassigned: number;
  notify: Notification[];
}

/**
 * Re-routes pending requests to the approver `approverFor` now picks for each requester
 * (read after the change that prompted it, inside the caller's transaction): their
 * active manager, else their department's active manager, else the longest-standing
 * other active admin, else the requester themself when they are an admin; never
 * self-approval. A request the rule would leave with the approver it already has is
 * left alone (so an only admin's request routed to themself stays put); one nobody can
 * take keeps no assigned approver, and every admin still sees it in their inbox.
 *
 * Each move is compare-and-set on the request's current approver, writes
 * `leave_request.reassigned` and `leave.reassigned`, and queues a review email to the
 * new approver. Reads are batched (requesters, contexts, contacts and leave types: seven
 * queries at most, whatever the number of requests), so the caller's company lock is
 * held for one update and its audit rows per moved request.
 *
 * A step of the caller's use case, on its transaction (`store`): it returns plain values
 * and lets a thrown error roll the caller back.
 */
export async function reroutePending(deps: ApprovalDeps, store: ApprovalStore, actor: Actor, requests: readonly LeaveRequest[]): Promise<Rerouted> {
  const moves = await planMoves(store, actor, requests);
  if (moves.length === 0) return { reassigned: 0, notify: [] };
  const [contacts, leaveTypes] = await Promise.all([
    store.directory.activeContacts(actor.companyId, moves.flatMap(({ request, approverId }) => [request.userId, approverId])),
    store.directory.leaveTypeNames(actor.companyId),
  ]);
  const notify: Notification[] = [];
  let reassigned = 0;
  for (const { request, approverId } of moves) {
    const after = await store.requests.reassignIfCurrent({ companyId: actor.companyId, id: request.id, from: request.approverId }, approverId);
    if (!after) continue;
    await store.changes.reassignment({ before: request, after, source: actor.source });
    reassigned++;

    const approver = approverId && approverId !== request.userId ? contacts.get(approverId) : undefined;
    if (!approver) continue;
    const leave = summarize(after, contacts.get(request.userId), leaveTypes.get(after.leaveTypeId) ?? "Time off");
    notify.push({
      type: "leave.requested",
      to: approver.email,
      data: { requestId: after.id, recipientName: approver.name, leave, link: `${deps.appUrl}/approvals`, approveLink: approveLinkFor(deps, after.id, approver.id) },
    });
  }
  return { reassigned, notify };
}

/** The requests whose approver the rule changes now, each once, with who takes it. */
async function planMoves(store: ApprovalStore, actor: Actor, requests: readonly LeaveRequest[]): Promise<Move[]> {
  const pending = [...new Map(requests.map((r) => [r.id, r])).values()];
  if (pending.length === 0) return [];
  const requesters = await store.contexts.requesters(actor.companyId, [...new Set(pending.map((r) => r.userId))]);
  const contexts = await store.contexts.contextsFor(actor.companyId, requesters);
  return pending.flatMap((request) => {
    const context = contexts.get(request.userId);
    if (!context) return [];
    const approverId = approverFor(context);
    return approverId === request.approverId ? [] : [{ request, approverId }];
  });
}
