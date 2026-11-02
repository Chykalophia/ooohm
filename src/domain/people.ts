/**
 * Rules for managing people: the shape of names and emails, who may manage whom, and
 * the guard that keeps every company administrable. Pure; the admin services load the
 * facts these rules need inside their transaction and call them before writing.
 */
import { ROLES, type Role } from "./actor";
import { DomainError } from "./errors";

/** Longest name an admin may give a person. Display trims further (see `displayName`). */
export const PERSON_NAME_MAX_LENGTH = 100;

/** Longest email address accepted (RFC 5321's limit on a forward path). */
export const EMAIL_MAX_LENGTH = 254;

// Exactly the rule Better Auth's magic-link endpoint applies (zod's `z.email()`,
// copied because the domain takes no dependencies; a unit test keeps the two in step).
// Anything looser would let an invite create an account that can never get a sign-in
// link, and would store address-list syntax (`,`, `<>`) a mailer could misread.
const EMAIL = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/**
 * An email as it is stored: trimmed and lowercased (`user_email_lowercase` requires it,
 * and Better Auth looks addresses up lowercased).
 *
 * @throws DomainError `invalid_input` when it is not an email address.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL.test(email)) {
    throw new DomainError("invalid_input", "That isn't an email address.");
  }
  return email;
}

/**
 * A person's name as stored: whitespace collapsed to single spaces and trimmed, so a
 * name is always one line.
 *
 * @throws DomainError `invalid_input` when blank or longer than {@link PERSON_NAME_MAX_LENGTH}.
 */
export function normalizePersonName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > PERSON_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

export const DEPARTMENT_NAME_MAX_LENGTH = 60;

/**
 * A department name as stored: one line, trimmed.
 *
 * @throws DomainError `invalid_input` when blank or longer than {@link DEPARTMENT_NAME_MAX_LENGTH}.
 */
export function normalizeDepartmentName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > DEPARTMENT_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Department names are 1 to ${DEPARTMENT_NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

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
