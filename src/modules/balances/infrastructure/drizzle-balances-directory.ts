import "server-only";
import type { Executor, Transaction } from "@/db/types";
import { findCompanySettings, listCompanies, listHolidayDates, listHolidays } from "@/server/repositories/calendar";
import { listActiveRequestsInRange } from "@/server/repositories/leave-requests";
import { findActiveLeaveType, listActiveLeaveTypesWithAllowance, listLeaveTypesWithAllowance } from "@/server/repositories/leave-type-allowances";
import { listActiveMembers, lockMember, lockMembers } from "@/shared/lib/db/members";
import { findDepartment, findLeaveTypeForAdmin, findLevel, listAllLeaveTypes, listDepartments, listLevels, lockCompanyForChange } from "@/modules/organisation";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import type { BalancesDirectory } from "../application/ports";

/** The {@link BalancesDirectory} on the old repositories, bound to `ex` (locks need a transaction). */
export function drizzleBalancesDirectory(ex: Executor): BalancesDirectory {
  const tx = ex as Transaction;
  return {
    companies: () => listCompanies(ex),
    company: async (companyId) => {
      const settings = await findCompanySettings(ex, companyId);
      return settings && { id: companyId, ...settings };
    },
    lockCompany: (companyId) => lockCompanyForChange(tx, companyId),
    assertActiveAdmin: (actor) => assertActiveAdmin(ex, actor),
    holidayDates: (companyId, from, to) => listHolidayDates(ex, companyId, from, to),
    holidays: (companyId, from, to) => listHolidays(ex, companyId, from, to),
    activeRequestsInRange: (userId, from, to) => listActiveRequestsInRange(ex, userId, from, to),
    activeLeaveType: (companyId, id) => findActiveLeaveType(ex, companyId, id),
    activeLeaveTypes: (companyId) => listActiveLeaveTypesWithAllowance(ex, companyId),
    leaveTypesWithAllowance: (companyId) => listLeaveTypesWithAllowance(ex, companyId),
    leaveTypeForAdmin: (companyId, id) => findLeaveTypeForAdmin(ex, companyId, id),
    allLeaveTypes: (companyId) => listAllLeaveTypes(ex, companyId),
    activeMembers: (companyId) => listActiveMembers(ex, companyId),
    lockMember: (companyId, userId) => lockMember(tx, companyId, userId),
    lockMembers: (companyId, userIds) => lockMembers(tx, companyId, userIds),
    departments: (companyId) => listDepartments(ex, companyId),
    department: (companyId, id) => findDepartment(ex, companyId, id),
    levels: (companyId) => listLevels(ex, companyId),
    level: (companyId, id) => findLevel(ex, companyId, id),
  };
}

