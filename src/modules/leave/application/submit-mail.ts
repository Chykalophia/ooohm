import "server-only";
import type { Actor } from "@/domain/actor";
import type { Notification } from "@/server/notifications/catalog";
import type { LeaveRequest } from "../domain/leave-request";
import { activeContactsIn, summarize } from "./leave-changes";
import type { LeaveDeps, LeaveStore } from "./ports";
import { alsoOffText } from "./queries/also-off";

/** The submit's plan as its emails need it. */
interface MailPlan {
  assessment: { leaveType: { name: string } };
  decision: { kind: "auto_approve" | "route"; approverId: string };
  informId: string | null;
  headsUp: boolean;
}

/**
 * The emails a submit sends after commit: while approval is turned off, `leave.booked` to
 * the requester and `leave.heads_up` to whoever is told; when approved at once,
 * `leave.approved` to the requester; otherwise `leave.requested` to the approver (never
 * to the requester themself).
 */
export async function submitMail(deps: LeaveDeps, store: LeaveStore, actor: Actor, final: LeaveRequest, plan: MailPlan): Promise<Notification[]> {
  const { decision, informId } = plan;
  const contacts = await activeContactsIn(store.directory, actor.companyId, [actor.id, decision.approverId, ...(informId ? [informId] : [])]);
  const me = contacts.get(actor.id);
  const approver = contacts.get(decision.approverId);
  const told = informId ? contacts.get(informId) : undefined;
  const leave = summarize(final, me, plan.assessment.leaveType.name);
  const mail: Notification[] = [];
  const requestId = final.id;
  if (plan.headsUp) {
    if (me) mail.push({ type: "leave.booked", to: me.email, data: { requestId, recipientName: me.name, leave, link: `${deps.appUrl}/` } });
    if (told) {
      const alsoOff = await alsoOffLine(store, actor, final, told.id);
      mail.push({ type: "leave.heads_up", to: told.email, data: { requestId, recipientName: told.name, leave, alsoOff, link: `${deps.appUrl}/calendar` } });
    }
  } else if (decision.kind === "auto_approve") {
    if (me) mail.push({ type: "leave.approved", to: me.email, data: { requestId, recipientName: me.name, leave, reason: null, link: `${deps.appUrl}/` } });
  } else if (approver && approver.id !== actor.id) {
    const alsoOff = await alsoOffLine(store, actor, final, approver.id);
    mail.push({
      type: "leave.requested",
      to: approver.email,
      data: { requestId, recipientName: approver.name, leave, alsoOff, link: `${deps.appUrl}/approvals`, approveLink: deps.approveLink(requestId, approver.id) },
    });
  }
  return mail;
}

/** Who else is off, scoped to the requester's department as on the Approvals page, as `readerId` may see it. */
async function alsoOffLine(store: LeaveStore, actor: Actor, final: LeaveRequest, readerId: string): Promise<string | null> {
  const person = await store.directory.findPerson(actor.companyId, actor.id);
  const department = person?.departmentId ? await store.directory.department(actor.companyId, person.departmentId) : undefined;
  const request = { ...final, userId: actor.id, departmentId: department?.id ?? null, departmentName: department?.name ?? null };
  return alsoOffText((await store.alsoOff.lines(actor.companyId, [request], readerId)).get(final.id));
}
