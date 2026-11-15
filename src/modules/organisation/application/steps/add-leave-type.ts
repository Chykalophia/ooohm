import "server-only";
import type { Transaction } from "@/db/types";
import { insertLeaveType } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeFields, type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * Adds a leave type in the caller's transaction, with no audit row or event: for setup and
 * imports, which record it themselves (`recordLeaveTypeChange`, or their own audit). The
 * Leave types screen uses `createLeaveType`.
 */
export async function addLeaveType(tx: Transaction, values: LeaveTypeFields & { companyId: string; sortOrder: number }): Promise<LeaveTypeSettingsDTO> {
  return toLeaveTypeSettingsDTO(await insertLeaveType(tx, values));
}
