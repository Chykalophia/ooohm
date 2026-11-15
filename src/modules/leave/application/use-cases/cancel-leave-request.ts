import "server-only";
import type { Actor } from "@/domain/actor";
import { readApprovalMode } from "@/domain/approval-rule";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { todayInTimeZone } from "@/lib/dates";
import type { Notification } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { cancelLeave, type LeaveRequest } from "../../domain/leave-request";
import { canCancel } from "../../domain/leave-permissions";
import { type LeaveRequestDTO, toLeaveRequestDTO } from "../dto";
import { activeContactsIn, recordEvent, summarize } from "../leave-changes";
import type { CompanySettings, LeaveDeps, LeaveStore } from "../ports";

/**
 * Cancels one of the actor's own requests, pending or already approved, unless it is
 * approved leave that is over (`leave_taken`) or of a closed year (`past_year_closed`).
 *
 * Emails the requester, and the approver too unless the approver is the person
 * cancelling (a self-approved request). While approval is turned off, someone
 * cancelling time off they booked themself also tells whoever was told about it
 * (their manager now, else the fallback admin: `ApprovalRouter.currentApprover`).
 *
 * Fails with `not_found`, `forbidden` (not the requester), `invalid_transition`
 * (already rejected or cancelled), `past_year_closed`, `leave_taken`, or `conflict`
 * when the request changed concurrently.
 */
export async function cancelLeaveRequest(deps: LeaveDeps, actor: Actor, requestId: string): Promise<ServiceResult<LeaveRequestDTO>> {
  if (!isUuid(requestId)) return err("not_found");
  return attempt(() =>
    deps.unitOfWork(actor.companyId, async (store) => {
      const before = await store.requests.lock(actor.companyId, requestId);
      if (!before) throw new DomainError("not_found");
      if (!canCancel(actor, before)) throw new DomainError("forbidden");
      const settings = await store.directory.companySettings(actor.companyId);
      if (!settings) throw new DomainError("no_company");
      const cancelled = unwrap(cancelLeave(before, todayInTimeZone(settings.timezone, deps.clock.now())));

      const after = await store.requests.updateStatusIfCurrent(
        { companyId: actor.companyId, id: before.id, from: before.status },
        { status: "cancelled" },
      );
      if (!after) throw new DomainError("conflict");
      await recordEvent(store.changes, cancelled.event, { before, after }, actor.source);
      return { result: toLeaveRequestDTO(after), notify: await cancelMail(deps, store, actor, after, settings) };
    }),
  );
}

/** `leave.cancelled_requester` to the requester, and `leave.cancelled_approver` to whoever decided or was told. */
async function cancelMail(deps: LeaveDeps, store: LeaveStore, actor: Actor, after: LeaveRequest, settings: CompanySettings): Promise<Notification[]> {
  const contacts = await activeContactsIn(store.directory, actor.companyId, [after.userId, after.approverId]);
  const leaveType = await store.directory.leaveType(actor.companyId, after.leaveTypeId);
  const requester = contacts.get(after.userId);
  const leave = summarize(after, requester, leaveType?.name ?? "Time off");
  const mail: Notification[] = [];
  if (requester) {
    mail.push({
      type: "leave.cancelled_requester",
      to: requester.email,
      data: { requestId: after.id, recipientName: requester.name, leave, link: `${deps.appUrl}/` },
    });
  }
  let approver = after.approverId ? contacts.get(after.approverId) : undefined;
  if (readApprovalMode(settings.approvalMode) === "heads_up" && after.approverId === after.userId) {
    const toldId = await store.approvals.currentApprover(actor.companyId, after.userId);
    approver = toldId && toldId !== after.userId ? (await activeContactsIn(store.directory, actor.companyId, [toldId])).get(toldId) : undefined;
  }
  if (approver && approver.id !== actor.id) {
    mail.push({
      type: "leave.cancelled_approver",
      to: approver.email,
      data: { requestId: after.id, recipientName: approver.name, leave, link: `${deps.appUrl}/approvals` },
    });
  }
  return mail;
}
