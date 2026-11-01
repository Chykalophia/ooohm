import { and, asc, eq, isNull } from "drizzle-orm";
import { leaveTypes } from "@/db/schema";
import type { Executor } from "@/db/types";

const fields = { id: leaveTypes.id, name: leaveTypes.name, code: leaveTypes.code, color: leaveTypes.color };

/** Non-archived leave types in display order. The first one is the form's default. */
export async function listActiveLeaveTypes(ex: Executor, companyId: string) {
  return ex
    .select(fields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.companyId, companyId), isNull(leaveTypes.archivedAt)))
    .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
}

/** Any leave type of the company, archived or not, e.g. to describe an existing request. */
export async function findLeaveType(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select(fields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId)));
  return row;
}

export async function findActiveLeaveType(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select(fields)
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.companyId, companyId), isNull(leaveTypes.archivedAt)));
  return row;
}
