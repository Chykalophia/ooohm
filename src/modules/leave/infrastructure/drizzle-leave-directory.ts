import "server-only";
import type { Executor, Transaction } from "@/db/types";
import { findCompanySettings, listHolidayDates } from "@/server/repositories/calendar";
import { findCompany, findDepartment, findLeaveType, findLeaveTypeForAdmin } from "@/modules/organisation";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-type-allowances";
import { shareLockCompany } from "@/shared/lib/db/company-lock";
import { findContacts, findPerson, lockMember, lockPerson } from "@/server/repositories/users";
import type { LeaveDirectory } from "../application/ports";

/** What leave reads of the company, people, departments and leave types, on Drizzle, bound to `ex`. */
export function drizzleLeaveDirectory(ex: Executor): LeaveDirectory {
  const tx = ex as Transaction;
  return {
    shareLockCompany: (companyId) => shareLockCompany(tx, companyId),
    companySettings: (companyId) => findCompanySettings(ex, companyId),
    company: (companyId) => findCompany(ex, companyId),
    holidayDates: (companyId, from, to) => listHolidayDates(ex, companyId, from, to),
    lockMember: (companyId, userId) => lockMember(tx, companyId, userId),
    lockPerson: (companyId, userId) => lockPerson(tx, companyId, userId),
    findPerson: (companyId, userId) => findPerson(ex, companyId, userId),
    department: (companyId, id) => findDepartment(ex, companyId, id),
    contacts: (companyId, ids) => findContacts(ex, companyId, ids),
    leaveType: (companyId, id) => findLeaveType(ex, companyId, id),
    leaveTypeForAdmin: (companyId, id) => findLeaveTypeForAdmin(ex, companyId, id),
    leaveTypesWithAllowance: (companyId) => listLeaveTypesWithAllowance(ex, companyId),
  };
}
