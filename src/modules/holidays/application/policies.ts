import "server-only";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/**
 * Who may change the company's holidays. Admins only; use cases check again inside their
 * transaction that the admin is still active.
 */

/** Whether `actor` may list, add, rename and delete the company's holidays. */
export function canManageHolidays(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
