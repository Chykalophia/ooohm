import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { readApprovalMode } from "@/domain/approval-rule";
import { type CompanySettingsInput, normalizeCompanySettings } from "@/domain/company-settings";
import { type CompanyChange, changeCompany } from "@/modules/organisation/application/company-changes";

/**
 * Inside the caller's transaction: saves the company's settings (name, time zone, working
 * days, allowance policy, approval mode, deletion grace, what people see of each other's
 * time off) and records `company.updated` when anything differs. Takes the company lock
 * first and checks the actor is still an active admin.
 *
 * The caller checks the actor first (`canManageCompanySettings`) and does what follows
 * from new working days (the leave recount), in the same transaction.
 *
 * @throws DomainError `no_company`, `forbidden`, or `invalid_input`.
 */
export async function saveCompanySettings(tx: Transaction, actor: Actor, input: CompanySettingsInput): Promise<CompanyChange> {
  return changeCompany(tx, actor, (b) => ({
    deletionGrace: b.deletionGrace,
    managersSeeDetails: b.managersSeeDetails,
    approvalMode: readApprovalMode(b.approvalMode),
    colleagueVisibility: b.colleagueVisibility,
    departmentScoping: b.departmentScoping,
    ...normalizeCompanySettings(input, b.timezone),
  }));
}
