import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { map, type ServiceResult } from "@/shared/lib/result";
import type { NamedAllowanceRuleDTO } from "../dto";
import type { BalancesDeps } from "../ports";
import { getAllowanceRulesForm } from "./get-allowance-rules-form";

/** One leave type's rules, named, as {@link getAllowanceRulesForm} lists them. Fails with `forbidden`. */
export async function listAllowanceRulesForAdmin(deps: BalancesDeps, actor: Actor, leaveTypeId: string): Promise<ServiceResult<NamedAllowanceRuleDTO[]>> {
  return map(await getAllowanceRulesForm(deps, actor, leaveTypeId), (form) => form.rules);
}
