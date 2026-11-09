import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { departments, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

export type DepartmentRow = { id: string; name: string; managerId: string | null };

const fields = { id: departments.id, name: departments.name, managerId: departments.managerId };
const manager = alias(user, "manager");

/** The company's departments by name, ignoring case (every department list and picker uses this order). */
export async function listDepartments(ex: Executor, companyId: string) {
  return ex
    .select(fields)
    .from(departments)
    .where(eq(departments.companyId, companyId))
    .orderBy(asc(sql`lower(${departments.name})`), asc(departments.id));
}

/**
 * The company's departments by name, each with how many people (active or not) are in
 * it and its manager's name and email (for a label), if it has one. One query.
 */
export async function listDepartmentsWithCounts(ex: Executor, companyId: string) {
  return ex
    .select({ ...fields, managerName: manager.name, managerEmail: manager.email, members: count(user.id) })
    .from(departments)
    .leftJoin(user, eq(user.departmentId, departments.id))
    .leftJoin(manager, eq(manager.id, departments.managerId))
    .where(eq(departments.companyId, companyId))
    .groupBy(departments.id, manager.id)
    .orderBy(asc(sql`lower(${departments.name})`), asc(departments.id));
}

/** Each of `departmentIds` (of the company) that has a manager, mapped to that manager's id. */
export async function findDepartmentManagerIds(ex: Executor, companyId: string, departmentIds: readonly string[]) {
  if (departmentIds.length === 0) return new Map<string, string>();
  const rows = await ex
    .select({ id: departments.id, managerId: departments.managerId })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), inArray(departments.id, [...departmentIds])));
  return new Map(rows.flatMap((r) => (r.managerId ? [[r.id, r.managerId] as const] : [])));
}

/** The ids of the departments `userId` manages, in id order. */
export async function listManagedDepartmentIds(ex: Executor, companyId: string, userId: string): Promise<string[]> {
  const rows = await ex
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), eq(departments.managerId, userId)))
    .orderBy(asc(departments.id));
  return rows.map((r) => r.id);
}

export async function findDepartment(ex: Executor, companyId: string, id: string): Promise<DepartmentRow | undefined> {
  const [row] = await ex
    .select(fields)
    .from(departments)
    .where(and(eq(departments.id, id), eq(departments.companyId, companyId)));
  return row;
}

/**
 * Holds a row lock on the department until commit, so a concurrent move of someone into
 * it cannot slip in between "it is empty" and the delete.
 */
export async function lockDepartment(tx: Transaction, companyId: string, id: string): Promise<DepartmentRow | undefined> {
  const [row] = await tx
    .select(fields)
    .from(departments)
    .where(and(eq(departments.id, id), eq(departments.companyId, companyId)))
    .for("update");
  return row;
}

/** A department of the company with this name, ignoring case, other than `exceptId`. */
export async function findDepartmentByName(ex: Executor, companyId: string, name: string, exceptId?: string) {
  const [row] = await ex
    .select(fields)
    .from(departments)
    .where(
      and(
        eq(departments.companyId, companyId),
        sql`lower(${departments.name}) = lower(${name})`,
        exceptId ? sql`${departments.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return row;
}

export async function insertDepartment(tx: Transaction, values: { companyId: string; name: string }): Promise<DepartmentRow> {
  const [row] = await tx.insert(departments).values(values).returning(fields);
  return row;
}

export async function renameDepartment(tx: Transaction, companyId: string, id: string, name: string): Promise<DepartmentRow> {
  const [row] = await tx
    .update(departments)
    .set({ name })
    .where(and(eq(departments.id, id), eq(departments.companyId, companyId)))
    .returning(fields);
  return row;
}

export async function setDepartmentManagerRow(tx: Transaction, companyId: string, id: string, managerId: string | null): Promise<DepartmentRow> {
  const [row] = await tx
    .update(departments)
    .set({ managerId })
    .where(and(eq(departments.id, id), eq(departments.companyId, companyId)))
    .returning(fields);
  return row;
}

/** Clears `userId` as manager of every department they manage; returns those departments after the change. */
export async function clearDepartmentsManagedBy(tx: Transaction, companyId: string, userId: string): Promise<DepartmentRow[]> {
  return tx
    .update(departments)
    .set({ managerId: null })
    .where(and(eq(departments.companyId, companyId), eq(departments.managerId, userId)))
    .returning(fields);
}

export async function deleteDepartment(tx: Transaction, companyId: string, id: string): Promise<void> {
  await tx.delete(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId)));
}
