import "server-only";
import type { Executor } from "@/db/types";
import { findDepartment as findDepartmentRow } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";

/**
 * One of the company's departments, or `undefined` when it has none with this id. Runs on
 * the executor it is given; the caller checks the actor.
 */
export async function findDepartment(ex: Executor, companyId: string, id: string): Promise<DepartmentDTO | undefined> {
  const row = await findDepartmentRow(ex, companyId, id);
  return row && toDepartmentDTO(row);
}
