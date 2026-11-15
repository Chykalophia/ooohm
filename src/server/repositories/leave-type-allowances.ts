import "server-only";
/**
 * The leave type settings the allowance policy reads: what balances, the year rollover
 * and the request form are computed from. The leave type catalog itself (names, codes,
 * the admin screens) belongs to the organisation module; these reads stay with the
 * balance code, which turns a type's own default into each person's default through
 * `loadAllowanceDefaults`.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { leaveTypes } from "@/db/schema";
import type { Executor } from "@/db/types";

/** Display fields plus the settings the allowance policy reads. */
const balanceFields = {
  id: leaveTypes.id,
  name: leaveTypes.name,
  code: leaveTypes.code,
  color: leaveTypes.color,
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

/**
 * Every leave type of the company with its allowance settings, archived ones too
 * (flagged), for balance views: active types in display order, then archived ones by
 * name. The request form must use {@link listActiveLeaveTypesWithAllowance} instead.
 */
export async function listLeaveTypesWithAllowance(ex: Executor, companyId: string) {
  return ex
    .select({ ...balanceFields, archived: sql<boolean>`${leaveTypes.archivedAt} is not null`.mapWith(Boolean) })
    .from(leaveTypes)
    .where(eq(leaveTypes.companyId, companyId))
    .orderBy(sql`${leaveTypes.archivedAt} is not null`, asc(leaveTypes.sortOrder), asc(leaveTypes.name), asc(leaveTypes.id));
}
