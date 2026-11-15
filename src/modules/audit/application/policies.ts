import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/** Whether `actor` may read their company's audit log (the viewer and a person's records export): admins only. */
export function canViewAuditLog(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
