import "server-only";
import { and, eq } from "drizzle-orm";
import { allowanceRules } from "@/db/schema";
import type { Transaction } from "@/db/types";

/**
 * The one write organisation makes to `allowance_rules`, which the balance code owns
 * otherwise: the rules of a department or level go when it is deleted.
 */

export type AllowanceRuleRow = { id: string; leaveTypeId: string; departmentId: string | null; levelId: string | null; days: number };

const fields = {
  id: allowanceRules.id,
  leaveTypeId: allowanceRules.leaveTypeId,
  departmentId: allowanceRules.departmentId,
  levelId: allowanceRules.levelId,
  days: allowanceRules.days,
};

/** Deletes every rule of a department or of a level (before that is deleted); returns them. */
export async function deleteAllowanceRulesOf(
  tx: Transaction,
  companyId: string,
  target: { departmentId: string } | { levelId: string },
): Promise<AllowanceRuleRow[]> {
  return tx
    .delete(allowanceRules)
    .where(
      and(
        eq(allowanceRules.companyId, companyId),
        "departmentId" in target ? eq(allowanceRules.departmentId, target.departmentId) : eq(allowanceRules.levelId, target.levelId),
      ),
    )
    .returning(fields);
}
