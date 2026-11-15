import "server-only";
/** What an admin sets about a person, and the checks it passes before anything is written. */
import type { Executor, Transaction } from "@/db/types";
import type { Role } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { findDepartment, findLevel } from "@/modules/organisation";
import { assertValidManager, isRole, type ReportingLine } from "@/modules/people/domain/people";
import { listReportingLines } from "@/modules/people/infrastructure/drizzle-people.repository";
import { normalizePersonName } from "@/shared/kernel/names";

/** What an admin sets about a person. */
export interface PersonInput {
  name: string;
  departmentId: string | null;
  /** Their level, for allowance rules. Left out: unchanged (none for someone new). */
  levelId?: string | null;
  managerId: string | null;
  role: string;
  canSelfApprove: boolean;
}

export interface InviteInput extends PersonInput {
  email: string;
}

/** A {@link PersonInput} as it is stored. */
export interface PersonFields {
  name: string;
  role: Role;
  departmentId: string | null;
  levelId?: string | null;
  managerId: string | null;
  canSelfApprove: boolean;
}

/** @throws DomainError `invalid_input` for a malformed field. */
export function normalizePersonInput(input: PersonInput): PersonFields {
  if (!isRole(input.role)) throw new DomainError("invalid_input", "Unknown role.");
  if (input.departmentId !== null && !isUuid(input.departmentId)) throw new DomainError("invalid_input", "Unknown department.");
  if (input.levelId !== undefined && input.levelId !== null && !isUuid(input.levelId)) throw new DomainError("invalid_input", "Unknown level.");
  if (input.managerId !== null && (input.managerId.length === 0 || input.managerId.length > 100)) {
    throw new DomainError("invalid_input", "Unknown manager.");
  }
  return {
    name: normalizePersonName(input.name),
    role: input.role,
    departmentId: input.departmentId,
    ...(input.levelId !== undefined && { levelId: input.levelId }),
    managerId: input.managerId,
    canSelfApprove: input.canSelfApprove === true,
  };
}

/**
 * Checks the department and level are the company's.
 *
 * @throws DomainError `invalid_input`.
 */
export async function assertPlacement(tx: Transaction, companyId: string, fields: Pick<PersonFields, "departmentId" | "levelId">): Promise<void> {
  if (fields.departmentId !== null && !(await findDepartment(tx, companyId, fields.departmentId))) {
    throw new DomainError("invalid_input", "Unknown department.");
  }
  if (fields.levelId && !(await findLevel(tx, companyId, fields.levelId))) throw new DomainError("invalid_input", "Unknown level.");
}

/** Every member's reporting line, by id, for the manager rules. */
export async function reportingLines(ex: Executor, companyId: string) {
  const rows = await listReportingLines(ex, companyId);
  return { rows, lines: new Map<string, ReportingLine>(rows.map((r) => [r.id, { managerId: r.managerId, isActive: r.isActive }])) };
}

/**
 * Checks `managerId` may manage `personId` (`null` for someone new).
 *
 * @throws DomainError `invalid_manager` or `manager_cycle`.
 */
export async function assertManagerFor(tx: Transaction, companyId: string, personId: string | null, managerId: string | null): Promise<void> {
  assertValidManager(personId, managerId, (await reportingLines(tx, companyId)).lines);
}
