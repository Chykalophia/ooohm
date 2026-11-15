import "server-only";
import type { Actor } from "@/domain/actor";
import { personLabel } from "@/shared/kernel/person-label";
import type { ServiceContext } from "@/server/context";
import { listPeopleNames } from "@/server/repositories/users";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import type { DepartmentManagerChoiceDTO } from "@/modules/organisation/application/dto";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/** Who may manage a department, for its manager picker: every active member, by name. Fails with `forbidden` for a non-admin. */
export async function listDepartmentManagerChoices(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<DepartmentManagerChoiceDTO[]>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  const names = await listPeopleNames(ctx.db, actor.companyId);
  return ok(names.filter((n) => n.isActive).map((n) => ({ id: n.id, label: personLabel(n) })));
}
