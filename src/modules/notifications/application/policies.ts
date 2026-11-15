import "server-only";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/** Whether `actor` may read, preview, change and reset their company's email copy (Admin → Emails): admins only. */
export function canEditEmailCopy(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
