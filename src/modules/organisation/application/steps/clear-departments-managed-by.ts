import "server-only";
import type { Transaction } from "@/db/types";
import { clearDepartmentsManagedBy as clearManagedBy } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";

/**
 * Clears `userId` as manager of every department they manage, in the caller's
 * transaction; returns those departments after the change. The caller records each
 * change (a person's deletion does).
 */
export async function clearDepartmentsManagedBy(tx: Transaction, companyId: string, userId: string): Promise<DepartmentDTO[]> {
  return (await clearManagedBy(tx, companyId, userId)).map(toDepartmentDTO);
}
