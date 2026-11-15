import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { personLabel } from "@/shared/kernel/person-label";
import type { Notification } from "@/modules/notifications";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { createDateRange } from "../../domain/date-range";
import type { LeaveRequest } from "../../domain/leave-request";
import { normalizeNote } from "../../domain/note";
import { type AddedLeaveDTO, toLeaveRequestDTO } from "../dto";
import { assessFor, checkAddFor } from "../leave-for";
import { activeContactsIn, summarize } from "../leave-changes";
import type { LeaveDeps, LeaveStore, Person } from "../ports";
import { storeSubmission } from "../store-submission";
import { SUBMIT_LIMIT, SUBMIT_WINDOW_MINUTES, type SubmitLeaveInput } from "./submit-leave-request";

/**
 * Adds time off for someone else, approved on the spot: an admin for anyone in their
 * company, or a manager for the people who report to them directly or whose department
 * they manage. For when the person can't or didn't ask themself (they called in sick, or
 * the leave was agreed in person).
 *
 * Counted and checked exactly as the person's own request would be (working days,
 * holidays, overlaps and a tracked balance), under the person's member lock so it cannot
 * race their own submits. It is stored as theirs, with the one adding it as its
 * approver, and is recorded as `requested` then `approved`, both by the one adding it,
 * so the audit log and the outbox name who did it. The person is emailed; they can
 * cancel it from "Your requests" as any of their own requests.
 *
 * Fails as submit's assessment, plus `not_found` (nobody active by that id in the
 * company), `forbidden` (not an admin, their manager or their department's manager, or
 * the actor themself) and `rate_limited` (as for the person's own submits).
 */
export async function addLeaveFor(deps: LeaveDeps, actor: Actor, userId: string, input: SubmitLeaveInput): Promise<ServiceResult<AddedLeaveDTO>> {
  const range = createDateRange(input.startDate, input.endDate, input.dayPortion);
  if (!range.ok) return range;
  return attempt(async () => {
    const note = normalizeNote(input.note);
    if (!isUuid(userId)) throw new DomainError("not_found");
    if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");
    return deps.unitOfWork(actor.companyId, async (store) => {
      // The order submit locks in: company (shared), then the member the leave is for.
      await store.directory.shareLockCompany(actor.companyId);
      const { person, seesBalance } = await checkAddFor(store.directory, actor, await store.directory.lockPerson(actor.companyId, userId));
      if ((await store.requests.countRecentByRequester(person.id, SUBMIT_WINDOW_MINUTES)) >= SUBMIT_LIMIT) {
        throw new DomainError("rate_limited");
      }
      const assessment = await assessFor(store, actor, person, input, seesBalance);
      const plan = { assessment, decision: { kind: "auto_approve" as const, approverId: actor.id } };
      const approved = await storeSubmission(deps, store, actor, { plan, range: range.value, note, userId: person.id });
      const notify = await addedMail(deps, store, actor, person, approved, assessment.leaveType.name);
      return { result: { ...toLeaveRequestDTO(approved), personName: personLabel(person) }, notify };
    });
  });
}

/** `leave.added` to the person the time off is for, naming who added it. */
async function addedMail(deps: LeaveDeps, store: LeaveStore, actor: Actor, person: Person, approved: LeaveRequest, leaveTypeName: string): Promise<Notification[]> {
  const contacts = await activeContactsIn(store.directory, actor.companyId, [person.id, actor.id]);
  const them = contacts.get(person.id);
  const me = contacts.get(actor.id);
  if (!them) return [];
  return [
    {
      type: "leave.added",
      to: them.email,
      data: {
        requestId: approved.id,
        recipientName: them.name,
        leave: summarize(approved, them, leaveTypeName),
        addedByName: me ? personLabel(me) : "",
        link: `${deps.appUrl}/`,
      },
    },
  ];
}
