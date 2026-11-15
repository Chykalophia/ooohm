import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { canAdminister } from "@/shared/kernel/admin-permissions";

/** Who may list, invite, edit, deactivate and reactivate people: admins. */
export function canManagePeople(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Who may delete a person, schedule or undo a scrub, and export their records first: admins. */
export function canDeletePeople(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}

/** Who may add people from a CSV file: admins. */
export function canImportPeople(actor: Pick<Actor, "role">): boolean {
  return canAdminister(actor);
}
