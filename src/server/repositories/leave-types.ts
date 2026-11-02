import { and, asc, eq, isNull, max, ne, sql } from "drizzle-orm";
import { leaveTypes } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

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

/** Every setting the admin screens show and edit. */
const adminFields = {
  ...balanceFields,
  isPaid: leaveTypes.isPaid,
  sortOrder: leaveTypes.sortOrder,
  archivedAt: leaveTypes.archivedAt,
};

export type LeaveTypeRow = {
  id: string;
  name: string;
  code: string;
  color: string;
  isPaid: boolean;
  countsAgainstAllowance: boolean;
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  carryoverMaxDays: number | null;
  sortOrder: number;
  archivedAt: Date | null;
};

/**
 * Every leave type of the company, archived ones too, in display order: active types by
 * sort order then name, then archived ones by name.
 */
export async function listAllLeaveTypes(ex: Executor, companyId: string): Promise<LeaveTypeRow[]> {
  return ex
    .select(adminFields)
    .from(leaveTypes)
    .where(eq(leaveTypes.companyId, companyId))
    .orderBy(sql`${leaveTypes.archivedAt} is not null`, asc(leaveTypes.sortOrder), asc(leaveTypes.name), asc(leaveTypes.id));
}

/** The company's leave type with this code (codes are stored uppercase), archived or not. */
export async function findLeaveTypeByCode(ex: Executor, companyId: string, code: string): Promise<LeaveTypeRow | undefined> {
  const [row] = await ex
    .select(adminFields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.companyId, companyId), eq(leaveTypes.code, code)));
  return row;
}

/** One leave type of the company with every admin setting, archived or not. */
export async function findLeaveTypeForAdmin(ex: Executor, companyId: string, id: string): Promise<LeaveTypeRow | undefined> {
  const [row] = await ex
    .select(adminFields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId)));
  return row;
}

/** Whether another leave type of the company already uses `code`. */
export async function leaveTypeCodeTaken(ex: Executor, companyId: string, code: string, exceptId?: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: leaveTypes.id })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.companyId, companyId), eq(leaveTypes.code, code), exceptId ? ne(leaveTypes.id, exceptId) : undefined))
    .limit(1);
  return row !== undefined;
}

/** One past the largest sort order in the company, so a new type goes last. */
export async function nextLeaveTypeSortOrder(ex: Executor, companyId: string): Promise<number> {
  const [row] = await ex.select({ top: max(leaveTypes.sortOrder) }).from(leaveTypes).where(eq(leaveTypes.companyId, companyId));
  return row?.top === null || row?.top === undefined ? 0 : row.top + 1;
}

export type LeaveTypeValues = Omit<LeaveTypeRow, "id" | "archivedAt" | "sortOrder">;

export async function insertLeaveType(
  tx: Transaction,
  values: LeaveTypeValues & { companyId: string; sortOrder: number },
): Promise<LeaveTypeRow> {
  const [row] = await tx.insert(leaveTypes).values(values).returning(adminFields);
  return row;
}

export async function updateLeaveType(
  tx: Transaction,
  companyId: string,
  id: string,
  set: Partial<LeaveTypeValues> & { sortOrder?: number; archivedAt?: Date | null },
): Promise<LeaveTypeRow> {
  const [row] = await tx
    .update(leaveTypes)
    .set(set)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId)))
    .returning(adminFields);
  return row;
}
