import "server-only";
import type { Transaction } from "@/db/types";
import { DomainError } from "@/shared/kernel/errors";
import { updateLeaveType } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeFields, type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * Writes leave type settings as given, in the caller's transaction, with no audit row or
 * event: for an import that records the change itself. The Leave types screen uses
 * `updateLeaveType`.
 *
 * @throws DomainError `not_found` when the company has no leave type with that id.
 */
export async function applyLeaveTypeChanges(
  tx: Transaction,
  companyId: string,
  id: string,
  set: Partial<LeaveTypeFields> & { sortOrder?: number; archivedAt?: Date | null },
): Promise<LeaveTypeSettingsDTO> {
  const row = await updateLeaveType(tx, companyId, id, set);
  if (!row) throw new DomainError("not_found");
  return toLeaveTypeSettingsDTO(row);
}
