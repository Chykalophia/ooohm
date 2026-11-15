import "server-only";
import type { Executor } from "@/db/types";
import { findLeaveType as findLeaveTypeRow } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeDTO, toLeaveTypeDTO } from "@/modules/organisation/application/dto";

/**
 * Any leave type of the company, archived or not, by its names and colour (e.g. to
 * describe an existing request), or `undefined`. Runs on the executor it is given; the
 * caller checks the actor.
 */
export async function findLeaveType(ex: Executor, companyId: string, id: string): Promise<LeaveTypeDTO | undefined> {
  const row = await findLeaveTypeRow(ex, companyId, id);
  return row && toLeaveTypeDTO(row);
}
