import "server-only";
import type { Transaction } from "@/db/types";
import { insertDepartment } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";

/**
 * Adds a department in the caller's transaction, with no audit row or event: for an
 * import that records the department itself (the people CSV, the TimeOff import). The
 * Departments screen uses `createDepartment`.
 */
export async function addDepartment(tx: Transaction, values: { companyId: string; name: string }): Promise<DepartmentDTO> {
  return toDepartmentDTO(await insertDepartment(tx, values));
}
