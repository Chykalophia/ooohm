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
 *   another approver, or they were deactivated).
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
 * Reads what an approve link points at, without changing anything: email scanners
 * open links before people do, so a GET must never decide. Three queries at most.
 */
export async function readEmailApproval(ctx: ServiceContext, token: string): Promise<EmailApproval> {
  if (!ctx.linkKey) return { state: "invalid" };
  const check = verifyApproveToken(ctx.linkKey, token, ctx.now());
  if (!check.ok) return { state: check.reason };
  const { requestId, approverId } = check.claims;
  if (!isUuid(requestId)) return { state: "invalid" };
  const actor = await linkActor(ctx, approverId);
  if (!actor) return { state: "not_yours" };
  const request = await findRequestForReview(ctx.db, actor.companyId, requestId);
  if (!request) return { state: "invalid" };
  if (request.status !== "pending") return { state: "decided", request };
  // The full rule (the approval rule still picks them) runs on approve; this is the cheap part.
  if (request.approverId !== actor.id && actor.role !== "admin") return { state: "not_yours" };
  return { state: "ready", request };
}

/**
 * Approves the request an approve link names, as the approver it was sent to, through
 * the link: the same {@link decideLeaveRequest} as the Approvals page, with every check
 * it makes, and an audit row and event whose actor reads `via: "email_link"`. Declining
 * needs a reason, so it is never offered here.
 */
export async function approveFromEmail(ctx: ServiceContext, token: string): Promise<EmailApproval> {
  const read = await readEmailApproval(ctx, token);
  if (read.state !== "ready" || !ctx.linkKey) return read;
  const check = verifyApproveToken(ctx.linkKey, token, ctx.now());
  if (!check.ok) return { state: check.reason };
  const actor = await linkActor(ctx, check.claims.approverId);
  if (!actor) return { state: "not_yours" };
  try {
    await decideLeaveRequest(ctx, actor, { requestId: read.request.id, decision: "approve" });
  } catch (err) {
    if (isDomainError(err, "forbidden")) return { state: "not_yours" };
    if (isDomainError(err, "invalid_transition") || isDomainError(err, "conflict")) {
      const now = await findRequestForReview(ctx.db, actor.companyId, read.request.id);
      return now ? { state: "decided", request: now } : { state: "invalid" };
    }
    throw err;
  }
  return { state: "approved", request: { ...read.request, status: "approved" } };
}
