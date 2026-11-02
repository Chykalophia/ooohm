import { and, asc, count, eq, sql } from "drizzle-orm";
import { departments, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

export type DepartmentRow = { id: string; name: string };

const fields = { id: departments.id, name: departments.name };

/** The company's departments by name, ignoring case (every department list and picker uses this order). */
export async function listDepartments(ex: Executor, companyId: string) {
  return ex
    .select(fields)
    .from(departments)
    .where(eq(departments.companyId, companyId))
    .orderBy(asc(sql`lower(${departments.name})`), asc(departments.id));
}

/** The company's departments by name, each with how many people (active or not) are in it. One query. */
export async function listDepartmentsWithCounts(ex: Executor, companyId: string) {
  return ex
    .select({ ...fields, members: count(user.id) })
    .from(departments)
    .leftJoin(user, eq(user.departmentId, departments.id))
    .where(eq(departments.companyId, companyId))
    .groupBy(departments.id)
    .orderBy(asc(sql`lower(${departments.name})`), asc(departments.id));
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

export async function deleteDepartment(tx: Transaction, companyId: string, id: string): Promise<void> {
  await tx.delete(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId)));
}
