import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { isUuid } from "@/shared/kernel/uuid";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import type { AllowanceRulesFormDTO } from "../dto";
import { canManageAllowanceRules } from "../policies";
import type { BalancesDeps } from "../ports";

/**
 * What a leave type's rules card shows: its rules, in the order they were added, with
 * the names of their department and level, and the departments and levels a new rule
 * can name. Three reads, in parallel. Fails with `forbidden`.
 */
export async function getAllowanceRulesForm(deps: BalancesDeps, actor: Actor, leaveTypeId: string): Promise<ServiceResult<AllowanceRulesFormDTO>> {
  if (!canManageAllowanceRules(actor)) return err("forbidden");
  const { rules: repo, directory } = deps.read;
  const [rules, departments, levels] = await Promise.all([
    isUuid(leaveTypeId) ? repo.list(actor.companyId, leaveTypeId) : [],
    directory.departments(actor.companyId),
    directory.levels(actor.companyId),
  ]);
  const departmentName = new Map(departments.map((d) => [d.id, d.name]));
  const levelName = new Map(levels.map((l) => [l.id, l.name]));
  return ok({
    rules: rules.map((r) => ({
      ...r,
      departmentName: r.departmentId ? (departmentName.get(r.departmentId) ?? null) : null,
      levelName: r.levelId ? (levelName.get(r.levelId) ?? null) : null,
    })),
    departments: departments.map(({ id, name }) => ({ id, name })),
    levels,
  });
}
