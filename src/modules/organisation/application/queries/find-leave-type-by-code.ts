import "server-only";
import type { Executor } from "@/db/types";
import { findLeaveTypeByCode as findByCode } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * The company's leave type with this code (codes are stored uppercase), archived or not,
 * or `undefined`. Runs on the executor it is given; the caller checks the actor.
 */
export async function findLeaveTypeByCode(ex: Executor, companyId: string, code: string): Promise<LeaveTypeSettingsDTO | undefined> {
  const row = await findByCode(ex, companyId, code);
  return row && toLeaveTypeSettingsDTO(row);
}
