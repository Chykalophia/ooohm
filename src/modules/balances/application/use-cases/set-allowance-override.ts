import "server-only";
/**
 * Admin overrides of one person's allowance for one leave type and year.
 *
 * An override writes the allowance row's `days` (replacing the type's default for that
 * person and year) and `adjustment_days` (a correction on top), with a required reason.
 * It never writes `carried_over_days` directly: the year rollover owns that column.
 * Editing last year re-runs the rollover's step for that person and type in the same
 * transaction, so this year's carry follows at once; years before last are closed
 * (see `firstEditableAllowanceYear`). Lowering an allowance below what is already
 * booked is allowed; the balance then shows a negative remaining.
 */
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { type AllowanceEdit, assertAllowanceYear, normalizeAllowanceEdit } from "@/domain/leave-type-settings";
import { yearInTimeZone } from "@/lib/dates";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import type { AllowanceOverrideResult } from "../dto";
import { canEditAllowances } from "../policies";
import type { BalancesDeps } from "../ports";
import { writeAllowance } from "../write-allowance";

export interface AllowanceOverrideInput extends AllowanceEdit {
  userId: string;
  leaveTypeId: string;
  year: number;
}

/**
 * Sets a person's allowance for one leave type and year (last year, this year or a
 * later one).
 *
 * Takes the person's member lock (`FOR NO KEY UPDATE`) before reading or writing the
 * row, like submit and the year rollover: every writer of a person's balance inputs
 * takes it, so a submit in flight either sees the new allowance or finishes first.
 * Writes `audit_log` (`allowance.edited`, the reason in its `after`) and a
 * `balance.adjusted` event (`reason: "admin_edit"`) in the same transaction. An edit
 * to last year then recomputes the carry into this year, as the rollover would
 * (`allowance.carried_over` / `allowance.created`, attributed to the admin too).
 *
 * Fails with `forbidden`, `invalid_input` (amounts, reason, or a year before last),
 * `not_found` (a person or leave type outside the actor's company), `no_company`, or
 * `policy_unavailable` (editing last year under an unknown policy).
 */
export async function setAllowanceOverride(deps: BalancesDeps, actor: Actor, input: AllowanceOverrideInput): Promise<ServiceResult<AllowanceOverrideResult>> {
  if (!canEditAllowances(actor)) return err("forbidden");
  return attempt(async () => {
    const edit = normalizeAllowanceEdit(input);
    if (!isUuid(input.leaveTypeId)) throw new DomainError("not_found");
    return deps.unitOfWork(async (store) => {
      await store.directory.assertActiveAdmin(actor);
      const company = await store.directory.company(actor.companyId);
      if (!company) throw new DomainError("no_company");
      const currentYear = yearInTimeZone(company.timezone, deps.clock.now());
      assertAllowanceYear(input.year, currentYear);
      const member = await store.directory.lockMember(actor.companyId, input.userId);
      if (!member) throw new DomainError("not_found");
      const leaveType = await store.directory.leaveTypeForAdmin(actor.companyId, input.leaveTypeId);
      if (!leaveType) throw new DomainError("not_found");
      return writeAllowance(store, {
        company,
        currentYear,
        member,
        leaveType,
        year: input.year,
        days: edit.days,
        adjustmentDays: edit.adjustmentDays,
        reason: "admin_edit",
        source: actor.source,
        note: edit.reason,
      });
    });
  });
}
