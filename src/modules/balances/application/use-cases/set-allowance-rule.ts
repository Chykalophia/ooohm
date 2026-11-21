import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import { allowanceRulePayload as payload, allowanceRuleSnapshot as snapshot } from "@/modules/organisation";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { normalizeAllowanceRule, type Placement } from "../../domain/allowance-rules";
import type { AllowanceRuleResult } from "../dto";
import { canManageAllowanceRules } from "../policies";
import type { BalancesDeps } from "../ports";
import { thisYear, withDefaultsFollowing } from "../rule-change";

export interface AllowanceRuleInput extends Placement {
  leaveTypeId: string;
  days: number;
}

/**
 * Sets the allowance of a leave type for a department, a level, or both (the most
 * specific rule wins): creates the rule, or updates the days of the one for that exact
 * target. Moves the matching people's rows that were following the default
 * (`followDefaults`).
 *
 * Fails with `forbidden`, `invalid_input` (no target, or days out of range or finer
 * than a tenth), `not_found` (a leave type, department or level outside the actor's
 * company) or `conflict` (another admin added the same rule at that moment).
 */
export async function setAllowanceRule(deps: BalancesDeps, actor: Actor, input: AllowanceRuleInput): Promise<ServiceResult<AllowanceRuleResult>> {
  if (!canManageAllowanceRules(actor)) return err("forbidden");
  return attempt(async () => {
    const rule = normalizeAllowanceRule(input);
    for (const id of [input.leaveTypeId, rule.departmentId, rule.levelId]) if (id !== null && !isUuid(id)) throw new DomainError("not_found");
    try {
      return await deps.unitOfWork(actor.companyId, async (store) => {
        const year = await thisYear(store, deps.clock, actor);
        const [type, department, level] = await Promise.all([
          store.directory.leaveTypeForAdmin(actor.companyId, input.leaveTypeId),
          rule.departmentId ? store.directory.department(actor.companyId, rule.departmentId) : null,
          rule.levelId ? store.directory.level(actor.companyId, rule.levelId) : null,
        ]);
        if (!type || department === undefined || level === undefined) throw new DomainError("not_found");

        const before = await store.rules.findFor(actor.companyId, input.leaveTypeId, rule);
        if (before && before.days === rule.days) return { ...before, allowancesUpdated: 0 };
        const { result: after, allowancesUpdated } = await withDefaultsFollowing(store, actor, { target: rule, leaveTypeId: input.leaveTypeId, fromYear: year }, async () => {
          const saved = before
            ? await store.rules.updateDays(actor.companyId, before.id, rule.days)
            : await store.rules.insert({ companyId: actor.companyId, leaveTypeId: input.leaveTypeId, ...rule });
          await store.changes.recordAdmin(actor, {
            type: ADMIN_EVENT_TYPES.allowanceRuleSet,
            entityType: "allowance_rule",
            entityId: saved.id,
            before: before ? snapshot(before) : null,
            after: snapshot(saved),
            payload: payload(saved),
          });
          return saved;
        });
        return { ...after, allowancesUpdated };
      });
    } catch (error) {
      // Two admins adding the same rule at once: the loser reads it as already there.
      if (isUniqueViolation(error, "allowance_rules_target_uq")) throw new DomainError("conflict");
      throw error;
    }
  });
}
