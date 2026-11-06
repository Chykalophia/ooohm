import { type Actor, isAdmin } from "./actor";

/** The ownership facts of a leave request that permission checks depend on. */
export interface RequestOwnership {
  companyId: string;
  userId: string;
  approverId: string | null;
}

/** Only the person who asked for the time off may cancel it. */
export function canCancel(actor: Actor, request: RequestOwnership): boolean {
  return request.companyId === actor.companyId && request.userId === actor.id;
}

/**
 * Whether `actor`'s right to decide `request` rests on its stored assignment rather
 * than on being an admin: true for anyone who is not an admin, and for an admin
 * deciding their own request. Only then does {@link canDecide} need to know who the
 * approval rule would pick now.
 */
export function decidesByAssignment(actor: Actor, request: RequestOwnership): boolean {
  return !isAdmin(actor) || request.userId === actor.id;
}

/**
 * Whether `actor` may approve or reject `request`: any admin of the same company, or
 * its assigned approver while the assignment still matches the approval rule.
 *
 * A stored assignment can go stale: a submit racing a demotion or deactivation can
 * route a request to someone who has just lost the reason to decide it, and a request
 * an only admin routed to themself stays assigned to them after a second admin
 * arrives. So the assignment counts only while `currentApproverId` (who the approval
 * rule, minus self-approval, picks for the requester now: `reassignApprover`) is still
 * the actor. Anything else is left to the company's admins, who see every pending
 * request.
 *
 * Nobody decides their own request. The one exception is an admin whose request is
 * routed to themself, which the approval rule only does while they have no active
 * manager and no other active admin exists; without it that request could never be
 * decided.
 *
 * @param currentApproverId Read fresh in the deciding transaction. Ignored (pass
 *   `null`) when {@link decidesByAssignment} is false.
 */
export function canDecide(actor: Actor, request: RequestOwnership, currentApproverId: string | null): boolean {
  if (request.companyId !== actor.companyId) return false;
  if (!decidesByAssignment(actor, request)) return true;
  const holdsAssignment = request.approverId === actor.id && currentApproverId === actor.id;
  if (request.userId === actor.id) return holdsAssignment && isAdmin(actor);
  return holdsAssignment;
}

/** Who a team member is, as far as seeing their leave details goes. */
export interface PersonOwnership {
  id: string;
  companyId: string;
  managerId: string | null;
}

/**
 * Whether `actor` may see `person`'s private leave details (balances, the notes on their
 * requests and their approver's reasons) on the team member page: the person themself,
 * an admin of their company, or their direct manager while the company allows it
 * (`companies.managers_see_details`). Everyone else in the company sees only what the
 * team calendar shows: who is off and when.
 */
export function canSeeLeaveDetails(actor: Actor, person: PersonOwnership, managersSeeDetails: boolean): boolean {
  if (person.companyId !== actor.companyId) return false;
  if (person.id === actor.id || isAdmin(actor)) return true;
  return managersSeeDetails && person.managerId === actor.id;
}

/**
 * Whether `actor` may add time off for `person`, approved as it is added: an admin of
 * their company, or their direct manager. Never for oneself: one's own time off goes
 * through the request form and its approver like everyone else's.
 */
export function canAddLeaveFor(actor: Actor, person: PersonOwnership): boolean {
  if (person.companyId !== actor.companyId || person.id === actor.id) return false;
  return isAdmin(actor) || person.managerId === actor.id;
}

/**
 * Whether `actor` may correct `person`'s time off, removing approved leave that was
 * recorded wrongly (past leave included): the same people who may add it for them
 * ({@link canAddLeaveFor}), an admin of their company or their direct manager. Never
 * for oneself.
 */
export function canCorrectLeaveFor(actor: Actor, person: PersonOwnership): boolean {
  return canAddLeaveFor(actor, person);
}
