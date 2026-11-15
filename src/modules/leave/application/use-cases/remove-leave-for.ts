import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { resolveAllowancePolicy } from "@/modules/balances";
import { DomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import { personLabel } from "@/shared/kernel/person-label";
import { todayInTimeZone } from "@/lib/dates";
import type { Notification } from "@/modules/notifications";
import { attempt, type ServiceResult, unwrap } from "@/shared/lib/result";
import { type LeaveRequest, removeLeave } from "../../domain/leave-request";
import { canCorrectLeaveFor } from "../../domain/leave-permissions";
import { normalizeNote } from "../../domain/note";
import { type LeaveRequestDTO, toLeaveRequestDTO } from "../dto";
import { activeContactsIn, recordEvent, summarize } from "../leave-changes";
import { ownershipOf } from "../leave-for";
import type { CompanyFacts, LeaveDeps, LeaveStore, Person } from "../ports";

/**
 * Removes someone's approved time off to correct the record: it was entered by mistake,
 * twice, or they worked those days after all. Their direct manager, their department's
 * manager or an admin may ({@link canCorrectLeaveFor}), for approved leave of the open
 * year, past leave included. A closed year's leave is corrected with a balance
 * adjustment instead.
 *
 * The request becomes `cancelled`, with the reason in `decision_note`, recorded as
 * `cancelled` by the one removing it. Its days are back in the person's balance (leave
 * that began last year re-carries last year's unused days at once). The person is emailed.
 *
 * Fails with `invalid_input` (no reason, or one over the note limit), `not_found`,
 * `forbidden`, `invalid_transition` (not approved), `past_year_closed`, or `conflict`.
 */
export async function removeLeaveFor(deps: LeaveDeps, actor: Actor, requestId: string, reason: string): Promise<ServiceResult<LeaveRequestDTO>> {
  return attempt(async () => {
    const why = normalizeNote(reason, "reason");
    if (!why) throw new DomainError("invalid_input", "Say why it's being removed.", { field: "reason" });
    if (!isUuid(requestId)) throw new DomainError("not_found");
    return deps.unitOfWork(actor.companyId, async (store) => {
      const { person, before, company } = await lockForRemoval(store, actor, requestId);
      const today = todayInTimeZone(company.timezone, deps.clock.now());
      const removed = unwrap(removeLeave(before, today, why));
      const after = await store.requests.updateStatusIfCurrent(
        { companyId: actor.companyId, id: before.id, from: before.status },
        { status: "cancelled", decisionNote: why },
      );
      if (!after) throw new DomainError("conflict");
      await recordEvent(store.changes, removed.event, { before, after }, actor.source);
      const leaveTypeName = await recarryIfLastYear(store, actor, { person, before, after, company, today });
      return { result: toLeaveRequestDTO(after), notify: await removedMail(deps, store, actor, after, { leaveTypeName, why }) };
    });
  });
}

/**
 * Whose it is, unlocked; then the person, then the request: the order a manager change
 * locks in (person, then their requests), so the two can never deadlock. The person stays
 * locked, so an admin moving them to another manager can't land between the check and the change.
 */
async function lockForRemoval(store: LeaveStore, actor: Actor, requestId: string): Promise<{ person: Person; before: LeaveRequest; company: CompanyFacts }> {
  const owner = await store.requests.find(actor.companyId, requestId);
  if (!owner) throw new DomainError("not_found");
  const person = await store.directory.lockPerson(actor.companyId, owner.userId);
  if (!person || !canCorrectLeaveFor(actor, await ownershipOf(store.directory, actor.companyId, person))) {
    throw new DomainError("forbidden");
  }
  const before = await store.requests.lock(actor.companyId, requestId);
  if (!before || before.userId !== person.id) throw new DomainError("not_found");
  const company = await store.directory.company(actor.companyId);
  if (!company) throw new DomainError("no_company");
  return { person, before, company };
}

/**
 * Leave that began last year gives last year's days back too: re-carries them into this
 * year now, as the rollover would, rather than at its next nightly run. Returns the
 * leave type's name for the email.
 */
async function recarryIfLastYear(
  store: LeaveStore,
  actor: Actor,
  facts: { person: Person; before: LeaveRequest; after: LeaveRequest; company: CompanyFacts; today: string },
): Promise<string> {
  const { person, before, after, company } = facts;
  const leaveType = await store.directory.leaveTypeForAdmin(actor.companyId, after.leaveTypeId);
  const currentYear = Number(facts.today.slice(0, 4));
  if (leaveType && person.isActive && Number(before.startDate.slice(0, 4)) < currentYear) {
    await store.allowances.recarry({
      companyId: actor.companyId,
      timezone: company.timezone,
      policy: resolveAllowancePolicy(company.allowancePolicy),
      member: person,
      leaveType,
      closingYear: currentYear - 1,
      source: actor.source,
    });
  }
  return leaveType?.name ?? "Time off";
}

/** `leave.removed` to the person, naming who removed it and why. */
async function removedMail(deps: LeaveDeps, store: LeaveStore, actor: Actor, after: LeaveRequest, facts: { leaveTypeName: string; why: string }): Promise<Notification[]> {
  const contacts = await activeContactsIn(store.directory, actor.companyId, [after.userId, actor.id]);
  const them = contacts.get(after.userId);
  const me = contacts.get(actor.id);
  if (!them) return [];
  return [
    {
      type: "leave.removed",
      to: them.email,
      data: {
        requestId: after.id,
        recipientName: them.name,
        leave: summarize(after, them, facts.leaveTypeName),
        removedByName: me ? personLabel(me) : "",
        reason: facts.why,
        link: `${deps.appUrl}/requests`,
      },
    },
  ];
}
