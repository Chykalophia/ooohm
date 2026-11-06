"use server";

import { z } from "zod";
import { MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { formatCount } from "@/lib/format";
import { removeAllowanceRule, setAllowanceRule } from "@/server/services/admin-allowance-rules";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  not_found: "That leave type, department or level doesn't exist any more.",
  invalid_input: `Pick a department, a level or both, and 0 to ${MAX_ALLOWANCE_DAYS} days in steps of 0.1.`,
  conflict: "Someone else just set that rule. Reload to see it.",
};

/** "3 people's allowances moved with it." when rows followed the change. */
function moved(n: number): string {
  return n > 0 ? ` ${formatCount(n, "allowance", "allowances")} for this year moved with it.` : "";
}

export async function setAllowanceRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "allowance_rule_set",
    formData,
    z.object({ leaveTypeId: formFields.id, departmentId: formFields.optionalId, levelId: formFields.optionalId, days: formFields.number }),
    async (ctx, actor, input) => {
      const result = await setAllowanceRule(ctx, actor, input);
      return `Saved.${moved(result.allowancesUpdated)}`;
    },
    MESSAGES,
  );
}

export async function removeAllowanceRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "allowance_rule_remove",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      const result = await removeAllowanceRule(ctx, actor, id);
      return `Removed.${moved(result.allowancesUpdated)}`;
    },
    MESSAGES,
  );
}
