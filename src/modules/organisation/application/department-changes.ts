import "server-only";
import { DomainError } from "@/shared/kernel/errors";
import type { DepartmentEventPayload, Unattributed } from "@/shared/kernel/events";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import type { DepartmentDTO } from "@/modules/organisation/application/dto";

/** A department as its events carry it. */
export function departmentPayload(row: DepartmentDTO): Unattributed<DepartmentEventPayload> {
  return { departmentId: row.id, name: row.name, managerId: row.managerId, maxOff: row.maxOff };
}

/** Runs `work`, turning a unique-name race into `already_exists`. */
export async function withUniqueDepartmentName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "departments_company_lower_name_uq")) throw new DomainError("already_exists");
    throw err;
  }
}
