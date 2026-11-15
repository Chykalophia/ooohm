import "server-only";
import type { Executor } from "@/db/types";
import { listDepartments as listDepartmentRows } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";

/**
 * The company's departments by name, ignoring case (every department list and picker
 * uses this order), for other services' pickers and labels. Runs on the executor it is
 * given; the caller checks the actor.
 */
export async function listDepartments(ex: Executor, companyId: string): Promise<DepartmentDTO[]> {
  return (await listDepartmentRows(ex, companyId)).map(toDepartmentDTO);
}
