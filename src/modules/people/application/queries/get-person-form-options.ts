import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { type DepartmentDTO, type LevelDTO, listDepartments, listLevels } from "@/modules/organisation";
import { reportingLines } from "@/modules/people/application/person-input";
import { canManagePeople } from "@/modules/people/application/policies";
import { managerCandidates } from "@/modules/people/domain/people";
import { listPeopleNames } from "@/shared/lib/db/members";
import { personLabel } from "@/shared/kernel/person-label";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

export interface PersonFormOptionsDTO {
  departments: DepartmentDTO[];
  /** Empty when the company uses no levels; the form then leaves the field out. */
  levels: LevelDTO[];
  managers: { id: string; label: string }[];
}

/**
 * The pickers the invite and edit forms need: departments, levels, and the people
 * `personId` may report to (active, not themself, no reporting loop). Four queries in
 * parallel. Fails with `forbidden` for a non-admin.
 */
export async function getPersonFormOptions(ctx: ServiceContext, actor: Actor, personId: string | null): Promise<ServiceResult<PersonFormOptionsDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  ctx = forTenant(ctx, actor.companyId);
  return attempt(async () => {
    const [departments, levels, { rows, lines }, names] = await Promise.all([
      listDepartments(ctx.db, actor.companyId),
      listLevels(ctx.db, actor.companyId),
      reportingLines(ctx.db, actor.companyId),
      listPeopleNames(ctx.db, actor.companyId),
    ]);
    const allowed = new Set(managerCandidates(personId, lines));
    // Keep the person's current manager pickable even when no longer valid (e.g.
    // deactivated), so saving other fields never silently clears it. Saving it unchanged
    // is allowed; choosing it anew is not.
    const current = personId ? rows.find((l) => l.id === personId)?.managerId : null;
    return {
      departments,
      levels,
      managers: names
        .filter((n) => allowed.has(n.id) || n.id === current)
        .map((n) => ({ id: n.id, label: n.isActive ? personLabel(n) : `${personLabel(n)} (deactivated)` })),
    };
  });
}
