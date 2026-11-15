import "server-only";
import type { ChangeSource } from "@/domain/change-source";
import { resolveAllowancePolicy } from "../domain/policy-registry";
import { recordAllowanceChange } from "./allowance-changes";
import type { AllowanceOverrideResult } from "./dto";
import { recarryMemberLeaveType } from "./member-rollover";
import type { AdminLeaveType, BalancesStore } from "./ports";

/** One write of a person's allowance for a year, as {@link writeAllowance} takes it. */
export interface AllowanceWrite {
  company: { id: string; timezone: string; allowancePolicy: string };
  currentYear: number;
  member: { id: string; isActive: boolean; createdAt: Date };
  leaveType: AdminLeaveType;
  year: number;
  days: number;
  adjustmentDays: number;
  reason: "admin_edit" | "sync";
  /** Recorded on the change and on any re-carry it causes. */
  source: ChangeSource;
  /** Free text kept in the audit row only (an admin's reason, or the sync's source). */
  note?: string;
}

/**
 * The write behind `setAllowanceOverride`, shared with the inbound sync
 * (`applyInboundSync`): sets `days` and `adjustment_days` of one allowance row (creating
 * it with nothing carried), records `audit_log` + `balance.adjusted` with `reason`, and,
 * for last year, re-carries into this year as the rollover would. Amounts that already
 * match write and record nothing.
 *
 * The caller has checked the year (`assertAllowanceYear`) and holds the person's member
 * lock, in the unit of work `store` is bound to.
 *
 * @throws DomainError `policy_unavailable` when last year is edited under an unknown policy.
 */
export async function writeAllowance(store: BalancesStore, job: AllowanceWrite): Promise<AllowanceOverrideResult> {
  const { company, member, leaveType } = job;
  const where = { userId: member.id, leaveTypeId: leaveType.id, year: job.year };
  const before = await store.allowances.find(where);
  if (before && before.days === job.days && before.adjustmentDays === job.adjustmentDays) return { row: before, changed: false };
  const after = await store.allowances.writeOverride({ ...where, days: job.days, adjustmentDays: job.adjustmentDays });
  await recordAllowanceChange(store.changes, { companyId: company.id, reason: job.reason, before: before ?? null, after, source: job.source, note: job.note });
  if (job.year < job.currentYear && member.isActive) {
    await recarryMemberLeaveType(store, {
      companyId: company.id,
      timezone: company.timezone,
      policy: resolveAllowancePolicy(company.allowancePolicy),
      member,
      leaveType,
      closingYear: job.year,
      source: job.source,
    });
  }
  return { row: after, changed: true };
}
