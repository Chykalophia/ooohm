import "server-only";
import type { Executor } from "@/db/types";
import { listAllLeaveTypes as listLeaveTypeRows } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/**
 * Every leave type of the company with every setting, archived ones too, in display
 * order: active types by sort order then name, then archived ones by name. Runs on the
 * executor it is given; the caller checks the actor. A balance reads a person's default
 * allowance through `loadAllowanceDefaults`, not from these.
 */
export async function listAllLeaveTypes(ex: Executor, companyId: string): Promise<LeaveTypeSettingsDTO[]> {
  return (await listLeaveTypeRows(ex, companyId)).map(toLeaveTypeSettingsDTO);
}
