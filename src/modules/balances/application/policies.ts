import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/**
 * Who may change allowances. Admins only today; use cases check again inside their
 * transaction that the admin is still active.
 */

/** Whether `actor` may set one person's allowance for a year. */
export function canEditAllowances(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may read, set and remove the allowance rules of a leave type. */
export function canManageAllowanceRules(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
