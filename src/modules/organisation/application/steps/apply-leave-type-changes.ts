import "server-only";
import type { Transaction } from "@/db/types";
import { updateLeaveType } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeFields, type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * Writes leave type settings as given, in the caller's transaction, with no audit row or
 * event: for an import that records the change itself. The Leave types screen uses
 * `updateLeaveType`.
 */
export async function applyLeaveTypeChanges(
  tx: Transaction,
  companyId: string,
  id: string,
  set: Partial<LeaveTypeFields> & { sortOrder?: number; archivedAt?: Date | null },
): Promise<LeaveTypeSettingsDTO> {
  return toLeaveTypeSettingsDTO(await updateLeaveType(tx, companyId, id, set));
}
