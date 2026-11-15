import "server-only";
import type { Executor } from "@/db/types";
import type { DeletionFacts } from "@/modules/people/domain/person-deletion";
import { countPendingAssignedTo, listReportsOf } from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { listActiveAdmins, type PersonRow } from "@/shared/lib/db/members";
import { personLabel } from "@/shared/kernel/person-label";

/** The facts behind the delete rules, read inside the caller's transaction (or on the pool for a preview). */
export async function loadDeletionFacts(ex: Executor, companyId: string, person: PersonRow): Promise<DeletionFacts> {
  const [reports, pendingApprovals, admins] = await Promise.all([
    listReportsOf(ex, companyId, person.id),
    countPendingAssignedTo(ex, companyId, person.id),
    listActiveAdmins(ex, companyId),
  ]);
  return {
    person,
    reports: reports.map((r) => ({ id: r.id, name: personLabel(r) })),
    pendingApprovals,
    activeAdminIds: admins.map((a) => a.id),
  };
}
