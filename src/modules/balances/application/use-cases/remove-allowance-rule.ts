import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import { allowanceRulePayload as payload, allowanceRuleSnapshot as snapshot } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { canManageAllowanceRules } from "../policies";
import type { BalancesDeps } from "../ports";
import { thisYear, withDefaultsFollowing } from "../rule-change";

/**
 * Removes a rule; its people go back to the next rule that matches them, or the type's
 * default, and rows that were following it move too (`followDefaults`). Fails with
 * `forbidden` or `not_found`.
 */
export async function removeAllowanceRule(deps: BalancesDeps, actor: Actor, id: string): Promise<ServiceResult<{ allowancesUpdated: number }>> {
  if (!canManageAllowanceRules(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    deps.unitOfWork(actor.companyId, async (store) => {
      const year = await thisYear(store, deps.clock, actor);
      const before = await store.rules.find(actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      const { allowancesUpdated } = await withDefaultsFollowing(store, actor, { target: before, leaveTypeId: before.leaveTypeId, fromYear: year }, async () => {
        await store.rules.delete(actor.companyId, id);
        await store.changes.recordAdmin(actor, {
          type: ADMIN_EVENT_TYPES.allowanceRuleRemoved,
          entityType: "allowance_rule",
          entityId: id,
          before: snapshot(before),
          after: null,
          payload: payload(before),
        });
      });
      return { allowancesUpdated };
    }),
  );
}
