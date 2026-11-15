/**
 * Rules for managing people: who may manage whom, and the guard that keeps every
 * company administrable. Pure; the use cases load the facts these rules need inside
 * their transaction and call them before writing. How names and emails are stored is
 * `@/shared/kernel/names`.
 */
import { ROLES, type Role } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** What the manager rules need to know about each member of the company. */
export interface ReportingLine {
  managerId: string | null;
  isActive: boolean;
}

/**
 * Checks a manager choice for `personId` (`null` for someone not created yet).
 *
 * - No manager is always fine: requests then go to an admin (see `ManagerApprovalRule`).
 * - The manager must be an active member of the company (a key of `members`), and
 *   not the person themself.
 * - The manager may not report to the person, directly or through others: walking up
 *   from the manager must never reach them. The walk follows inactive people too,
 *   since reactivating one would otherwise close the loop.
 *
 * @param members Every member of the company, active or not, by id.
 * @throws DomainError `invalid_manager` or `manager_cycle`.
 */
export function assertValidManager(
  personId: string | null,
  managerId: string | null,
  members: ReadonlyMap<string, ReportingLine>,
): void {
  if (managerId === null) return;
  if (managerId === personId || !members.get(managerId)?.isActive) throw new DomainError("invalid_manager");
  if (personId === null) return;

  const seen = new Set<string>();
  for (let current: string | null = managerId; current !== null; current = members.get(current)?.managerId ?? null) {
    if (current === personId) throw new DomainError("manager_cycle");
    // A loop that does not pass through the person (bad data from before this rule)
    // cannot be closed by this change, so stop instead of walking forever.
    if (seen.has(current)) return;
    seen.add(current);
  }
}

/**
 * The people `personId` could report to, for a manager picker: every member that
 * {@link assertValidManager} accepts, in the order given.
 */
export function managerCandidates(personId: string | null, members: ReadonlyMap<string, ReportingLine>): string[] {
  return [...members.keys()].filter((id) => {
    try {
      assertValidManager(personId, id, members);
      return true;
    } catch {
      return false;
    }
  });
}

/** A change to someone's role or active flag, as the last-admin guard sees it. */
export interface AdminSeatChange {
  personId: string;
  before: { role: Role; isActive: boolean };
  after: { role: Role; isActive: boolean };
}

/**
 * Keeps at least one active admin in the company: a company without one could never
 * be administered again without touching the database. Since only admins change roles,
 * in practice this stops the last admin demoting or deactivating themself.
 *
 * @param activeAdminIds The company's active admins before the change, read under the
 *   company lock so two admins cannot demote each other at once.
 * @throws DomainError `last_admin`.
 */
export function assertKeepsAnActiveAdmin(change: AdminSeatChange, activeAdminIds: readonly string[]): void {
  const wasSeat = change.before.role === "admin" && change.before.isActive;
  const keepsSeat = change.after.role === "admin" && change.after.isActive;
  if (wasSeat && !keepsSeat && !activeAdminIds.some((id) => id !== change.personId)) {
    throw new DomainError("last_admin");
  }
}

/**
 * Admins cannot deactivate themselves: it would end their own session mid-task with no
 * way back in. Another admin can (and the last-admin guard still applies to them).
 *
 * @throws DomainError `self_change_not_allowed`.
 */
export function assertNotSelfDeactivation(actorId: string, personId: string): void {
  if (actorId === personId) throw new DomainError("self_change_not_allowed");
}
