import "server-only";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/**
 * Who may change how the company is organised. Every rule is admins only today; each has
 * its own name so a screen asks the question it means, and a rule can change alone.
 * Use cases check again inside their transaction that the admin is still active.
 */

/** Whether `actor` may list, add, rename and delete their company's levels. */
export function canManageLevels(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may read and change the company's settings (name, time zone, working days, approval, visibility). */
export function canManageCompanySettings(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may change the company's appearance: theme, accent, corners, request style, layout and logo. */
export function canManageAppearance(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may list, add, rename and delete departments, and set their manager and coverage limit. */
export function canManageDepartments(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may list, add, edit, archive, restore and reorder leave types. */
export function canManageLeaveTypes(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
