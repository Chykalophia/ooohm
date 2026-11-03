import { type Actor, toActor } from "@/domain/actor";
import { byUser, CHANGE_PROCESSES } from "@/domain/change-source";
import { isDomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { APPROVE_LINK_DAYS, signApproveToken, verifyApproveToken } from "@/lib/email-link-token";
import type { ServiceContext } from "@/server/context";
import { findRequestForReview } from "@/server/repositories/leave-requests";
import { findActorById } from "@/server/repositories/users";
import { decideLeaveRequest } from "./approvals";

/**
 * The Approve link for a request email to `approverId`, or `null` where links cannot be
 * signed (a process without the key). Valid for {@link APPROVE_LINK_DAYS} days.
 */
export function approveLinkFor(ctx: ServiceContext, requestId: string, approverId: string): string | null {
  if (!ctx.linkKey) return null;
  const expiresAt = Math.floor(ctx.now().getTime() / 1000) + APPROVE_LINK_DAYS * 86_400;
  return `${ctx.appUrl}/approve/${signApproveToken(ctx.linkKey, { requestId, approverId, expiresAt })}`;
}

type Review = NonNullable<Awaited<ReturnType<typeof findRequestForReview>>>;

/**
 * What an approve link leads to:
 * - `invalid`: not a link this app signed, or its request is gone.
 * - `expired`: older than {@link APPROVE_LINK_DAYS} days.
 * - `decided`: the request is no longer pending (decided, cancelled, or approved through
 *   this very link before).
 * - `not_yours`: the person the email went to can no longer decide it (it moved to
 *   another approver, even an admin's, or they were deactivated).
 * - `ready`: pending and theirs to approve.
 * - `approved`: just approved through the link.
 */
export type EmailApproval =
  | { state: "invalid" | "expired" | "not_yours" }
  | { state: "decided"; request: Review }
  | { state: "ready" | "approved"; request: Review };

/** The approver the link names, acting through it, or `null` when they cannot act at all. */
async function linkActor(ctx: ServiceContext, approverId: string): Promise<Actor | null> {
  const person = await findActorById(ctx.db, approverId);
  if (!person?.isActive) return null;
  const actor = toActor(person);
  return actor && { ...actor, source: byUser(actor.id, CHANGE_PROCESSES.emailLink) };
}

/**
 * Checks a link and reads its request: the {@link EmailApproval} to show, and the
 * approver acting through the link when there is one. The link speaks only for the
 * person it was sent to, and only while the request is still theirs: once it moves to
 * someone else the link shows nothing about it, decided or not.
 */
async function resolveLink(ctx: ServiceContext, token: string): Promise<{ approval: EmailApproval; actor?: Actor }> {
  if (!ctx.linkKey) return { approval: { state: "invalid" } };
  const check = verifyApproveToken(ctx.linkKey, token, ctx.now());
  if (!check.ok) return { approval: { state: check.reason } };
  const { requestId, approverId } = check.claims;
  if (!isUuid(requestId)) return { approval: { state: "invalid" } };
  const actor = await linkActor(ctx, approverId);
  if (!actor) return { approval: { state: "not_yours" } };
  const request = await findRequestForReview(ctx.db, actor.companyId, requestId);
  if (!request) return { approval: { state: "invalid" } };
  if (request.approverId !== actor.id) return { approval: { state: "not_yours" } };
  if (request.status !== "pending") return { approval: { state: "decided", request } };
  // The full rule (the approval rule still picks them) runs on approve; this is the cheap part.
  return { approval: { state: "ready", request }, actor };
}

/**
 * Reads what an approve link points at, without changing anything: email scanners
 * open links before people do, so a GET must never decide. Two queries at most.
 */
export async function readEmailApproval(ctx: ServiceContext, token: string): Promise<EmailApproval> {
  return (await resolveLink(ctx, token)).approval;
}

/**
 * Approves the request an approve link names, as the approver it was sent to, through
 * the link: the same {@link decideLeaveRequest} as the Approvals page, with every check
 * it makes plus `assignedTo`, and an audit row and event whose actor reads
 * `via: "email_link"`. Declining needs a reason, so it is never offered here.
 */
export async function approveFromEmail(ctx: ServiceContext, token: string): Promise<EmailApproval> {
  const { approval, actor } = await resolveLink(ctx, token);
  if (approval.state !== "ready" || !actor) return approval;
  try {
    await decideLeaveRequest(ctx, actor, { requestId: approval.request.id, decision: "approve", assignedTo: actor.id });
  } catch (err) {
    if (isDomainError(err, "forbidden")) return { state: "not_yours" };
    if (isDomainError(err, "invalid_transition") || isDomainError(err, "conflict")) {
      const now = await findRequestForReview(ctx.db, actor.companyId, approval.request.id);
      if (!now) return { state: "invalid" };
      return now.approverId === actor.id ? { state: "decided", request: now } : { state: "not_yours" };
    }
    throw err;
  }
  return { state: "approved", request: { ...approval.request, status: "approved" } };
}
