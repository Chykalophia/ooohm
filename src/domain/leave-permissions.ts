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
 * Whether `actor` may approve or reject `request`: its assigned approver, or any admin
 * of the same company.
 *
 * Nobody decides their own request. The one exception is an admin whose request was
 * routed to themself, which the approval rule only does when no other active admin
 * exists; without it that request could never be decided. The exception lasts only
 * while they are still an admin: once demoted, the stored assignment grants nothing.
 */
export function canDecide(actor: Actor, request: RequestOwnership): boolean {
  if (request.companyId !== actor.companyId) return false;
  const isAssigned = request.approverId === actor.id;
  if (request.userId === actor.id) return isAssigned && isAdmin(actor);
  return isAssigned || isAdmin(actor);
}
