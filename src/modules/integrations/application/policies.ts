import "server-only";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/** Whether `actor` may see and change the company's webhook endpoints and their deliveries: admins only. */
export function canManageWebhooks(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may see, create and revoke the company's API keys: admins only. */
export function canManageApiKeys(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Whether `actor` may see the installed adapters and run a sync: admins only. */
export function canManageAdapters(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
