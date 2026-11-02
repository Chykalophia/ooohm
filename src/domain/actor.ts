import { byUser, type PersonChangeSource } from "./change-source";

export const ROLES = ["employee", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The authenticated person on whose behalf a service call runs.
 *
 * Built from the session, never from request input. `companyId` scopes every query a
 * service makes; a caller can never reach another company's data by passing an id.
 */
export interface Actor {
  readonly id: string;
  readonly companyId: string;
  readonly role: Role;
  readonly canSelfApprove: boolean;
  /**
   * How this person is acting, recorded on every change they make: themselves from a
   * session (`{ kind: "user", userId: id }`), or, once the API takes writes, through one
   * of their API keys. Its `userId` is always `id`.
   */
  readonly source: PersonChangeSource;
}

/** The subset of a session user that an `Actor` is derived from. */
export interface ActorSource {
  id: string;
  companyId?: string | null;
  role?: string | null;
  canSelfApprove?: boolean | null;
}

/**
 * Derives an `Actor` from a session user.
 *
 * @returns `null` when the user is not attached to a company yet; such a user can sign
 *   in but cannot act. An unrecognised role degrades to `employee` (least privilege).
 */
export function toActor(user: ActorSource): Actor | null {
  if (!user.companyId) return null;
  const role = (ROLES as readonly string[]).includes(user.role ?? "") ? (user.role as Role) : "employee";
  return { id: user.id, companyId: user.companyId, role, canSelfApprove: user.canSelfApprove === true, source: byUser(user.id) };
}

export function isAdmin(actor: Pick<Actor, "role">): boolean {
  return actor.role === "admin";
}
