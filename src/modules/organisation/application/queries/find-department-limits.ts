import "server-only";
import type { Executor } from "@/db/types";
import { findDepartmentLimits as findLimits } from "@/modules/organisation/infrastructure/drizzle-departments.repository";

/** Each of `departmentIds` (of the company) that has a coverage limit, mapped to it. Runs on the executor it is given. */
export async function findDepartmentLimits(ex: Executor, companyId: string, departmentIds: readonly string[]): Promise<Map<string, number>> {
  return findLimits(ex, companyId, departmentIds);
}
