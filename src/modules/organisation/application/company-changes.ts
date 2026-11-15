import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { readAppearance } from "@/domain/appearance";
import { readApprovalMode } from "@/domain/approval-rule";
import { readStoredLogo } from "@/domain/company-logo";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type CompanyEventPayload, type Unattributed } from "@/domain/events";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { type CompanyRow, lockAndFindCompany, updateCompany } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { type CompanyDTO, toCompanyDTO } from "@/modules/organisation/application/dto";

/** The company as its audit rows and `company.updated` events record it. */
function snapshot(row: CompanyRow) {
  return {
    name: row.name,
    timezone: row.timezone,
    workingDays: row.workingDays,
    allowancePolicy: row.allowancePolicy,
    deletionGrace: row.deletionGrace,
    managersSeeDetails: row.managersSeeDetails,
    approvalMode: readApprovalMode(row.approvalMode),
    colleagueVisibility: row.colleagueVisibility,
    departmentScoping: row.departmentScoping,
    ...readAppearance(row),
    logo: readStoredLogo(row),
  };
}

/** What a company change did. `changed` is false (nothing written or recorded) when it left the company as it was. */
export interface CompanyChange {
  before: CompanyDTO;
  after: CompanyDTO;
  changed: boolean;
}

/**
 * Inside `tx`: locks the company, checks the actor is still an active admin, applies
 * `change` (after that check, so input is only judged for an admin) and, when anything
 * differs, saves it and records `company.updated` with the audit row.
 *
 * @throws DomainError `no_company`, `forbidden`, or whatever `change` throws.
 */
export async function changeCompany(
  tx: Transaction,
  actor: Actor,
  change: (before: CompanyDTO) => Parameters<typeof updateCompany>[2],
): Promise<CompanyChange> {
  const before = await lockAndFindCompany(tx, actor.companyId);
  if (!before) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  const settings = change(toCompanyDTO(before));
  if (JSON.stringify(snapshot({ ...before, ...settings })) === JSON.stringify(snapshot(before))) {
    return { before: toCompanyDTO(before), after: toCompanyDTO(before), changed: false };
  }
  const after = await updateCompany(tx, actor.companyId, settings);
  const payload: Unattributed<CompanyEventPayload> = { companyId: after.id, ...snapshot(after) };
  await recordAdminChange(tx, actor, {
    type: ADMIN_EVENT_TYPES.companyUpdated,
    entityType: "company",
    entityId: after.id,
    before: snapshot(before),
    after: snapshot(after),
    payload,
  });
  return { before: toCompanyDTO(before), after: toCompanyDTO(after), changed: true };
}
