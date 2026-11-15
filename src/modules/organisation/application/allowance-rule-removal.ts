import "server-only";
/**
 * How an allowance rule is recorded, and the clean-up when its department or level is
 * deleted. Organisation holds it because deleting a department or level removes their
 * rules in the same transaction, and the balance code that owns the other rule changes
 * depends on organisation, never the reverse. The rule use cases record their changes
 * with the same snapshot and payload.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import { ADMIN_EVENT_TYPES, type AllowanceRuleEventPayload, type Unattributed } from "@/shared/kernel/events";
import { deleteAllowanceRulesOf } from "@/modules/organisation/infrastructure/drizzle-allowance-rules.repository";
import { recordAdminChange } from "@/shared/lib/admin-access";
import type { AllowanceRuleFacts } from "@/modules/organisation/application/dto";

/** A rule as its audit rows record it. */
export function allowanceRuleSnapshot(rule: AllowanceRuleFacts) {
  return { leaveTypeId: rule.leaveTypeId, departmentId: rule.departmentId, levelId: rule.levelId, days: rule.days };
}

/** A rule as its events carry it. */
export function allowanceRulePayload(rule: AllowanceRuleFacts): Unattributed<AllowanceRuleEventPayload> {
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
