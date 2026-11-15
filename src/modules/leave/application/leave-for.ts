import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError, isDomainError } from "@/shared/kernel/errors";
import { personLabel } from "@/shared/kernel/person-label";
import type { LeaveDraft } from "@/modules/balances";
import { canAddLeaveFor, canSeeLeaveDetails, type PersonOwnership } from "../domain/leave-permissions";
import type { LeaveDirectory, LeaveStore, Person } from "./ports";

/**
 * The facts about `person` that decide who manages them ({@link PersonOwnership}):
 * their manager, and their department's manager (one read, when they have a department).
 */
export async function ownershipOf(directory: LeaveDirectory, companyId: string, person: Pick<Person, "id" | "managerId" | "departmentId">): Promise<PersonOwnership> {
  const department = person.departmentId ? await directory.department(companyId, person.departmentId) : undefined;
  return { id: person.id, companyId, managerId: person.managerId, departmentManagerId: department?.managerId ?? null };
}

/**
 * Whether `actor` may add time off for `person`, and may see that person's balance: the
 * person must be active, and `actor` an admin, their direct manager or their
 * department's manager ({@link canAddLeaveFor}). Read with `person` from the caller's
 * store, so submit checks under its lock.
 */
export async function checkAddFor(directory: LeaveDirectory, actor: Actor, person: Person | undefined): Promise<{ person: Person; seesBalance: boolean }> {
  if (!person?.isActive) throw new DomainError("not_found");
  const owned = await ownershipOf(directory, actor.companyId, person);
  if (!canAddLeaveFor(actor, owned)) throw new DomainError("forbidden");
  const company = await directory.company(actor.companyId);
  if (!company) throw new DomainError("no_company");
  return { person, seesBalance: canSeeLeaveDetails(actor, owned, company.managersSeeDetails) };
}

/**
 * Assesses `draft` for `person`, hiding how many days they have left from someone who
 * may not see their balance (a manager, while the company keeps balances from
 * managers): a shortfall then says only that the days aren't there. Otherwise a
 * shortfall names the person, so its message reads "Ana only has…".
 */
export async function assessFor(store: LeaveStore, actor: Actor, person: Person, draft: LeaveDraft, seesBalance: boolean) {
  try {
    return await store.allowances.assess({ id: person.id, companyId: actor.companyId }, draft);
  } catch (err) {
    if (!isDomainError(err, "insufficient_balance")) throw err;
    if (!seesBalance || !err.details || !("year" in err.details)) throw new DomainError("insufficient_balance");
    throw new DomainError("insufficient_balance", undefined, { ...err.details, person: personLabel(person) });
  }
}
