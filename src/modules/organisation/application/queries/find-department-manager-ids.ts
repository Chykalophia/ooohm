import "server-only";
import type { Executor } from "@/db/types";
import { findDepartmentManagerIds as findManagerIds } from "@/modules/organisation/infrastructure/drizzle-departments.repository";

/**
 * Each of `departmentIds` (of the company) that has a manager, mapped to that manager's
 * id: what approval routing falls back to. Runs on the executor it is given.
 */
export async function findDepartmentManagerIds(ex: Executor, companyId: string, departmentIds: readonly string[]): Promise<Map<string, string>> {
  return findManagerIds(ex, companyId, departmentIds);
}
