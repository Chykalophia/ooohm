import { type Actor, isAdmin } from "./actor";
import { DomainError } from "./errors";

/**
 * Whether `actor` may use the admin screens and services: manage people, departments,
 * leave types, allowances, holidays and company settings, and read the audit log.
 * Only admins may, and only within their own company (every admin service scopes its
 * queries by `actor.companyId`).
 */
export function canAdminister(actor: Pick<Actor, "role">): boolean {
  return isAdmin(actor);
}

/**
 * The first line of every admin service.
 *
 * @throws DomainError `forbidden` when `actor` is not an admin.
 */
export function assertCanAdminister(actor: Pick<Actor, "role">): void {
  if (!canAdminister(actor)) throw new DomainError("forbidden");
}
