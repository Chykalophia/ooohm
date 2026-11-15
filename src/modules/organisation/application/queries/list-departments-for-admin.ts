import "server-only";
import type { Actor } from "@/domain/actor";
import { personLabel } from "@/shared/kernel/person-label";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { listDepartmentsWithCounts } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { type DepartmentSummaryDTO, toDepartmentSummaryDTO } from "@/modules/organisation/application/dto";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/**
 * The company's departments by name, with how many active people are in each
 * (`members`) and how many people point at it at all (`assigned`, deactivated
 * included), and who manages it (`managerId`, and `managerName` for its label), if
 * anyone. Fails with `forbidden` for a non-admin.
 */
export async function listDepartmentsForAdmin(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<DepartmentSummaryDTO[]>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  const rows = await listDepartmentsWithCounts(ctx.db, actor.companyId);
  return ok(
    rows.map(({ managerEmail, managerName, ...row }) =>
      toDepartmentSummaryDTO({
        ...row,
        managerName: row.managerId ? personLabel({ name: managerName ?? "", email: managerEmail ?? "" }) : null,
      }),
    ),
  );
}
