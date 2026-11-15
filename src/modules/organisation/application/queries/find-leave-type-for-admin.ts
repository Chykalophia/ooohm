import "server-only";
import type { Executor } from "@/db/types";
import { findLeaveTypeForAdmin as findLeaveTypeSettingsRow } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * One leave type of the company with every setting, archived or not, or `undefined`.
 * Runs on the executor it is given; the caller checks the actor.
 */
export async function findLeaveTypeForAdmin(ex: Executor, companyId: string, id: string): Promise<LeaveTypeSettingsDTO | undefined> {
  const row = await findLeaveTypeSettingsRow(ex, companyId, id);
  return row && toLeaveTypeSettingsDTO(row);
}
