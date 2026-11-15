import "server-only";
/**
 * How an allowance rule is recorded, and the clean-up when its department or level is
 * deleted. Kept apart from the rest of the allowance-rule use cases so that deleting a
 * level or a department does not depend on them.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { ADMIN_EVENT_TYPES, type AllowanceRuleEventPayload, type Unattributed } from "@/domain/events";
import { type AllowanceRuleRow, deleteAllowanceRulesOf } from "@/server/repositories/allowance-rules";
import { recordAdminChange } from "@/shared/lib/admin-access";

/** A rule as its audit rows record it. */
export function allowanceRuleSnapshot(rule: AllowanceRuleRow) {
  return { leaveTypeId: rule.leaveTypeId, departmentId: rule.departmentId, levelId: rule.levelId, days: rule.days };
}

/** A rule as its events carry it. */
export function allowanceRulePayload(rule: AllowanceRuleRow): Unattributed<AllowanceRuleEventPayload> {
  return { ruleId: rule.id, ...allowanceRuleSnapshot(rule) };
}

/**
 * Removes every rule of a department or level about to be deleted, recording
 * `allowance_rule.removed` for each (the foreign key would drop them silently). Nobody
 * is placed there any more, so no allowance moves.
 */
export async function removeRulesOf(tx: Transaction, actor: Actor, target: { departmentId: string } | { levelId: string }): Promise<void> {
  for (const rule of await deleteAllowanceRulesOf(tx, actor.companyId, target)) {
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.allowanceRuleRemoved,
      entityType: "allowance_rule",
      entityId: rule.id,
      before: allowanceRuleSnapshot(rule),
      after: null,
      payload: allowanceRulePayload(rule),
    });
  }
}
