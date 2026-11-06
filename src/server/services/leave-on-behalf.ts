import type { Actor } from "@/domain/actor";
import { remainingAfter, type RequestCost } from "@/domain/allowance-policy";
import { DomainError, isDomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { personLabel } from "@/domain/person";
import { canAddLeaveFor, canSeeLeaveDetails, type PersonOwnership } from "@/domain/leave-permissions";
import { assertValidRange, normalizeNote } from "@/domain/leave-request";
import { assertTransition } from "@/domain/request-status";
import type { Executor } from "@/db/types";
import type { ServiceContext } from "@/server/context";
import { insertRequestDays } from "@/server/repositories/balances";
import { findCompany, shareLockCompany } from "@/server/repositories/companies";
import { findDepartment } from "@/server/repositories/departments";
import { countRecentRequests, insertLeaveRequest, type LeaveRequestRow, updateStatusIfCurrent } from "@/server/repositories/leave-requests";
import { findPerson, lockPerson, type PersonRow } from "@/server/repositories/users";
import { assessLeaveRequest, draftRange, type LeaveDraft } from "./balances";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { SUBMIT_LIMIT, SUBMIT_WINDOW_MINUTES, type SubmitLeaveInput } from "./leave-requests";
import { commitThenNotify, type Outgoing } from "./notify";

/**
 * The facts about `person` that decide who manages them ({@link PersonOwnership}):
 * their manager, and their department's manager (one read, when they have a department).
 */
async function ownershipOf(ex: Executor, companyId: string, person: Pick<PersonRow, "id" | "managerId" | "departmentId">): Promise<PersonOwnership> {
  const department = person.departmentId ? await findDepartment(ex, companyId, person.departmentId) : undefined;
  return { id: person.id, companyId, managerId: person.managerId, departmentManagerId: department?.managerId ?? null };
}

/**
 * Who `actor` would add time off for, and whether they may see that person's balance:
 * the person must be active, and `actor` an admin, their direct manager or their
 * department's manager ({@link canAddLeaveFor}). Read with `person` from the caller's executor, so submit
 * checks under its lock.
 */
async function checkAddFor(ex: Executor, actor: Actor, person: PersonRow | undefined) {
  if (!person?.isActive) throw new DomainError("not_found");
  const owned = await ownershipOf(ex, actor.companyId, person);
  if (!canAddLeaveFor(actor, owned)) throw new DomainError("forbidden");
  const company = await findCompany(ex, actor.companyId);
  if (!company) throw new DomainError("no_company");
  return { seesBalance: canSeeLeaveDetails(actor, owned, company.managersSeeDetails) };
}

/**
 * Runs {@link assessLeaveRequest} for `person`, hiding how many days they have left from
 * someone who may not see their balance (a manager, while the company keeps balances
 * from managers): a shortfall then says only that the days aren't there. Otherwise a
 * shortfall names the person, so its message reads "Ana only has…".
 */
async function assessFor(ex: Executor, actor: Actor, person: PersonRow, draft: LeaveDraft, seesBalance: boolean) {
  try {
    return await assessLeaveRequest(ex, { id: person.id, companyId: actor.companyId }, draft);
  } catch (err) {
    if (!isDomainError(err, "insufficient_balance")) throw err;
    if (!seesBalance || !err.details || !("year" in err.details)) throw new DomainError("insufficient_balance");
    throw new DomainError("insufficient_balance", undefined, { ...err.details, person: personLabel(person) });
  }
}

/**
 * What adding this time off for `userId` would cost, for the live preview on their team
 * page. Runs the checks {@link addLeaveFor} runs, without writing anything. What they
 * would have left is shown only to someone who may see their balance. `personName` is
 * how the preview names them.
 *
 * @throws DomainError as {@link addLeaveFor}, minus `rate_limited`.
 */
export async function previewLeaveFor(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  draft: LeaveDraft,
): Promise<{ cost: RequestCost; personName: string }> {
  if (!isUuid(userId)) throw new DomainError("not_found");
  const person = await findPerson(ctx.db, actor.companyId, userId);
  const { seesBalance } = await checkAddFor(ctx.db, actor, person);
  const assessment = await assessFor(ctx.db, actor, person as PersonRow, draft, seesBalance);
  const years = assessment.charges.map(({ year, days, before }) => ({ year, days, remainingAfter: seesBalance ? remainingAfter(before, days) : null }));
  return { cost: { days: assessment.days, years }, personName: personLabel(person as PersonRow) };
}

/**
 * Adds time off for someone else, approved on the spot: an admin for anyone in their
 * company, or a manager for the people who report to them directly. For when the person
 * can't or didn't ask themself (they called in sick, or the leave was agreed in person).
 *
 * Counted and checked exactly as the person's own request would be
 * ({@link assessLeaveRequest}: working days, holidays, overlaps and a tracked balance),
 * under the person's member lock so it cannot race their own submits. It is stored as
 * theirs, with the one adding it as its approver, and is recorded as `requested` then
 * `approved`, both by the one adding it, so the audit log and the outbox name who did
 * it. The person is emailed; they can cancel it from "Your requests" as any of their
 * own requests.
 *
 * @returns The stored request, `approved`, with `personName`: how a confirmation names them.
 * @throws DomainError as {@link assessLeaveRequest}, plus `not_found` (nobody active
 *   by that id in the company), `forbidden` (not an admin or their manager, or the
 *   actor themself) and `rate_limited` (as for the person's own submits).
 */
export async function addLeaveFor(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  input: SubmitLeaveInput,
): Promise<LeaveRequestRow & { personName: string }> {
  assertValidRange(draftRange(input));
  const note = normalizeNote(input.note);
  if (!isUuid(userId)) throw new DomainError("not_found");
  if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  return commitThenNotify(ctx, async (tx) => {
    // The order submit locks in: company (shared), then the member the leave is for.
    await shareLockCompany(tx, actor.companyId);
    const person = await lockPerson(tx, actor.companyId, userId);
    const { seesBalance } = await checkAddFor(tx, actor, person);
    const subject = person as PersonRow;
    if ((await countRecentRequests(tx, subject.id, SUBMIT_WINDOW_MINUTES)) >= SUBMIT_LIMIT) {
      throw new DomainError("rate_limited");
    }

    const assessment = await assessFor(tx, actor, subject, input, seesBalance);
    const created = await insertLeaveRequest(tx, {
      companyId: actor.companyId,
      userId: subject.id,
      leaveTypeId: assessment.leaveType.id,
      ...assessment.range,
      days: assessment.days,
      note,
      status: "pending",
      approverId: actor.id,
    });
    await insertRequestDays(tx, created.id, assessment.charges);
    await recordLeaveChange(tx, { event: "requested", before: null, after: created, source: actor.source });

    assertTransition("pending", "approved");
    const approved = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: created.id, from: "pending" },
      { status: "approved", decidedAt: ctx.now() },
    );
    if (!approved) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: "approved", before: created, after: approved, source: actor.source });

    const contacts = await activeContacts(tx, actor.companyId, [subject.id, actor.id]);
    const them = contacts.get(subject.id);
    const me = contacts.get(actor.id);
    const mail: Outgoing[] = [];
    if (them) {
      mail.push({
        to: them.email,
        email: {
          kind: "added",
          recipientName: them.name,
          leave: summarize(approved, them, assessment.leaveType.name),
          addedByName: me ? personLabel(me) : "",
          link: `${ctx.appUrl}/`,
        },
      });
    }
    return { result: { ...approved, personName: personLabel(subject) }, outgoing: mail };
  });
}
