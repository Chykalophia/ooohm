import "server-only";
import type { Role } from "@/domain/actor";
import type { PersonRow } from "@/shared/lib/db/members";

/**
 * A person as the admin screens show and edit them. Their email is here because those
 * screens show it (and an admin invites by it); nothing other members see (Team, the
 * team feed) is built from this.
 */
export interface PersonDTO {
  id: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
  levelId: string | null;
  managerId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
  createdAt: Date;
  /** When a full scrub waiting out the company's grace period may run; `null` when none is scheduled. */
  scrubScheduledAt: Date | null;
}

/** One row of the admin people list: the person, with their department's and manager's names. */
export interface PersonListItemDTO extends PersonDTO {
  departmentName: string | null;
  managerName: string | null;
  managerEmail: string | null;
}

/** A passkey as the account page lists it: a name and when it was added, never the key. */
export interface PasskeyDTO {
  id: string;
  name: string | null;
  createdAt: Date | null;
  synced: boolean;
}

/** The signed-in person's own account, for their settings page. */
export interface AccountDTO {
  name: string;
  email: string;
  role: Role;
  /** The department's name, or `null` when they are in none. */
  department: string | null;
  /** The manager's display label (name, else email), or `null` when they have none. */
  manager: string | null;
  /** Their passkeys, oldest first. */
  passkeys: PasskeyDTO[];
  /** The company's time zone, to show when each passkey was added. */
  timezone: string;
}

export function toPersonDTO(p: PersonRow): PersonDTO {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    role: p.role,
    departmentId: p.departmentId,
    levelId: p.levelId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
    createdAt: p.createdAt,
    scrubScheduledAt: p.scrubScheduledAt,
  };
}

export function toPersonListItemDTO(
  p: PersonRow & { departmentName: string | null; managerName: string | null; managerEmail: string | null },
): PersonListItemDTO {
  return { ...toPersonDTO(p), departmentName: p.departmentName, managerName: p.managerName, managerEmail: p.managerEmail };
}

export function toPasskeyDTO(p: { id: string; name: string | null; createdAt: Date | null; deviceType: string }): PasskeyDTO {
  return { id: p.id, name: p.name, createdAt: p.createdAt, synced: p.deviceType === "multiDevice" };
}
