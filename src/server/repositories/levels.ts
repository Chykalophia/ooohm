import { and, asc, count, eq, sql } from "drizzle-orm";
import { levels, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

export type LevelRow = { id: string; name: string };

const fields = { id: levels.id, name: levels.name };

/**
 * The company's levels by name, each with two head counts: `members`, its active people
 * (what the page shows), and `assigned`, everyone still at it, deactivated included (what
 * keeps it from being deleted). One query.
 */
export async function listLevelsWithCounts(ex: Executor, companyId: string) {
  return ex
    .select({
      ...fields,
      members: sql<number>`count(${user.id}) filter (where ${user.isActive})`.mapWith(Number),
      assigned: count(user.id),
    })
    .from(levels)
    .leftJoin(user, eq(user.levelId, levels.id))
    .where(eq(levels.companyId, companyId))
    .groupBy(levels.id)
    .orderBy(asc(sql`lower(${levels.name})`), asc(levels.id));
}

/** The company's levels by name, ignoring case (every level list and picker uses this order). */
export async function listLevels(ex: Executor, companyId: string) {
  return ex
    .select(fields)
    .from(levels)
    .where(eq(levels.companyId, companyId))
    .orderBy(asc(sql`lower(${levels.name})`), asc(levels.id));
}

export async function findLevel(ex: Executor, companyId: string, id: string): Promise<LevelRow | undefined> {
  const [row] = await ex
    .select(fields)
    .from(levels)
    .where(and(eq(levels.id, id), eq(levels.companyId, companyId)));
  return row;
}

/**
 * Holds a row lock on the level until commit, so a concurrent move of someone into
 * it cannot slip in between "it is empty" and the delete.
 */
export async function lockLevel(tx: Transaction, companyId: string, id: string): Promise<LevelRow | undefined> {
  const [row] = await tx
    .select(fields)
    .from(levels)
    .where(and(eq(levels.id, id), eq(levels.companyId, companyId)))
    .for("update");
  return row;
}

/** A level of the company with this name, ignoring case, other than `exceptId`. */
export async function findLevelByName(ex: Executor, companyId: string, name: string, exceptId?: string) {
  const [row] = await ex
    .select(fields)
    .from(levels)
    .where(
      and(
        eq(levels.companyId, companyId),
        sql`lower(${levels.name}) = lower(${name})`,
        exceptId ? sql`${levels.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return row;
}

export async function insertLevel(tx: Transaction, values: { companyId: string; name: string }): Promise<LevelRow> {
  const [row] = await tx.insert(levels).values(values).returning(fields);
  return row;
}

export async function renameLevel(tx: Transaction, companyId: string, id: string, name: string): Promise<LevelRow> {
  const [row] = await tx
    .update(levels)
    .set({ name })
    .where(and(eq(levels.id, id), eq(levels.companyId, companyId)))
    .returning(fields);
  return row;
}

export async function deleteLevel(tx: Transaction, companyId: string, id: string): Promise<void> {
  await tx.delete(levels).where(and(eq(levels.id, id), eq(levels.companyId, companyId)));
}
