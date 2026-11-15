import "server-only";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/** Whether `actor` may list, add, rename and delete their company's levels: admins only. */
export function canManageLevels(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
