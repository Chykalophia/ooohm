import "server-only";
import type { Executor } from "@/db/types";
import { listManagedDepartmentIds as listManagedIds } from "@/modules/organisation/infrastructure/drizzle-departments.repository";

/** The ids of the departments `userId` manages, in id order: what the calendar scope reads. Runs on the executor it is given. */
export async function listManagedDepartmentIds(ex: Executor, companyId: string, userId: string): Promise<string[]> {
  return listManagedIds(ex, companyId, userId);
}
