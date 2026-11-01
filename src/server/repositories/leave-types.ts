import { and, asc, eq, isNull } from "drizzle-orm";
import { leaveTypes } from "@/db/schema";
import type { Executor } from "@/db/types";

const fields = { id: leaveTypes.id, name: leaveTypes.name, code: leaveTypes.code, color: leaveTypes.color };

/** Any leave type of the company, archived or not, e.g. to describe an existing request. */
export async function findLeaveType(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select(fields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId)));
  return row;
}

/** Display fields plus the settings the allowance policy reads. */
const balanceFields = {
  ...fields,
  countsAgainstAllowance: leaveTypes.countsAgainstAllowance,
  defaultAllowanceDays: leaveTypes.defaultAllowanceDays,
  carryoverEnabled: leaveTypes.carryoverEnabled,
  carryoverMaxDays: leaveTypes.carryoverMaxDays,
};

/** A non-archived leave type of the company, with its allowance settings. */
export async function findActiveLeaveType(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select(balanceFields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId), isNull(leaveTypes.archivedAt)));
  return row;
}

/**
 * Non-archived leave types in display order (the first one is the form's default),
 * with each type's allowance settings.
 */
export async function listActiveLeaveTypesWithAllowance(ex: Executor, companyId: string) {
  return ex
    .select(balanceFields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.companyId, companyId), isNull(leaveTypes.archivedAt)))
    .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
}
