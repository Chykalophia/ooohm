import "server-only";
import type { Executor } from "@/db/types";
import { activeContacts } from "@/modules/leave";
import { findCompanySettings } from "@/server/repositories/calendar";
import { findLeaveType, listAllLeaveTypes } from "@/modules/organisation";
import { findActorById } from "@/shared/lib/db/members";
import type { ApprovalDirectory } from "../application/ports";

/** The {@link ApprovalDirectory} on Drizzle, bound to `ex`. */
export function drizzleApprovalDirectory(ex: Executor): ApprovalDirectory {
  return {
    activeContacts: (companyId, ids) => activeContacts(ex, companyId, ids),
    leaveTypeName: async (companyId, id) => (await findLeaveType(ex, companyId, id))?.name,
    leaveTypeNames: async (companyId) => new Map((await listAllLeaveTypes(ex, companyId)).map((t) => [t.id, t.name])),
    linkPerson: (userId) => findActorById(ex, userId),
    timezone: async (companyId) => (await findCompanySettings(ex, companyId))?.timezone,
  };
}
