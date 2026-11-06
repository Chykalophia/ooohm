import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { allowanceRules, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { Placement } from "@/domain/allowance-rules";

const fields = {
  id: allowanceRules.id,
  leaveTypeId: allowanceRules.leaveTypeId,
  departmentId: allowanceRules.departmentId,
  levelId: allowanceRules.levelId,
  days: allowanceRules.days,
};

export type AllowanceRuleRow = { id: string; leaveTypeId: string; departmentId: string | null; levelId: string | null; days: number };

/** The company's allowance rules, optionally for one leave type, oldest first. */
export async function listAllowanceRules(ex: Executor, companyId: string, leaveTypeId?: string): Promise<AllowanceRuleRow[]> {
  return ex
    .select(fields)
    .from(allowanceRules)
    .where(and(eq(allowanceRules.companyId, companyId), leaveTypeId ? eq(allowanceRules.leaveTypeId, leaveTypeId) : undefined))
    .orderBy(asc(allowanceRules.createdAt), asc(allowanceRules.id));
}

export async function findAllowanceRule(ex: Executor, companyId: string, id: string): Promise<AllowanceRuleRow | undefined> {
  const [row] = await ex
    .select(fields)
    .from(allowanceRules)
    .where(and(eq(allowanceRules.id, id), eq(allowanceRules.companyId, companyId)));
  return row;
}

/** The rule for exactly this type and target, if there is one. */
export async function findAllowanceRuleFor(ex: Executor, companyId: string, leaveTypeId: string, target: Placement) {
  const [row] = await ex
    .select(fields)
    .from(allowanceRules)
    .where(
      and(
        eq(allowanceRules.companyId, companyId),
        eq(allowanceRules.leaveTypeId, leaveTypeId),
        target.departmentId ? eq(allowanceRules.departmentId, target.departmentId) : isNull(allowanceRules.departmentId),
        target.levelId ? eq(allowanceRules.levelId, target.levelId) : isNull(allowanceRules.levelId),
      ),
    );
  return row;
}

export async function insertAllowanceRule(
  tx: Transaction,
  values: { companyId: string; leaveTypeId: string; departmentId: string | null; levelId: string | null; days: number },
): Promise<AllowanceRuleRow> {
  const [row] = await tx.insert(allowanceRules).values(values).returning(fields);
  return row;
}

export async function updateAllowanceRuleDays(tx: Transaction, companyId: string, id: string, days: number): Promise<AllowanceRuleRow> {
  const [row] = await tx
    .update(allowanceRules)
    .set({ days })
    .where(and(eq(allowanceRules.id, id), eq(allowanceRules.companyId, companyId)))
    .returning(fields);
  return row;
}

export async function deleteAllowanceRule(tx: Transaction, companyId: string, id: string): Promise<void> {
  await tx.delete(allowanceRules).where(and(eq(allowanceRules.id, id), eq(allowanceRules.companyId, companyId)));
}

/** Where each of `userIds` (of the company) sits: department and level. */
export async function listPlacements(ex: Executor, companyId: string, userIds: readonly string[]) {
  if (userIds.length === 0) return new Map<string, Placement>();
  const rows = await ex
    .select({ id: user.id, departmentId: user.departmentId, levelId: user.levelId })
    .from(user)
    .where(and(eq(user.companyId, companyId), inArray(user.id, [...userIds])));
  return new Map(rows.map((r) => [r.id, { departmentId: r.departmentId, levelId: r.levelId }]));
}

/** Undeleted members of the company (active or not) a rule for this target applies to: everyone in the department and/or at the level. */
export async function listMembersAt(ex: Executor, companyId: string, target: Placement): Promise<string[]> {
  const rows = await ex
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.companyId, companyId),
        isNull(user.deletedAt),
        target.departmentId ? eq(user.departmentId, target.departmentId) : undefined,
        target.levelId ? eq(user.levelId, target.levelId) : undefined,
      ),
    )
    .orderBy(asc(sql`${user.id}`));
  return rows.map((r) => r.id);
}
