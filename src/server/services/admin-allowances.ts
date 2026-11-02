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
import { assertCanAdminister } from "@/domain/admin-permissions";
import { resolveAllowancePolicy } from "@/domain/allowance-policy";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { type AllowanceEdit, assertAllowanceYear, normalizeAllowanceEdit } from "@/domain/leave-type-settings";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { type AllowanceRow, findAllowance, writeAllowanceOverride } from "@/server/repositories/balances";
import { findCompany } from "@/server/repositories/companies";
import { findLeaveTypeForAdmin } from "@/server/repositories/leave-types";
import { lockMember } from "@/server/repositories/users";
import { assertActiveAdmin } from "./admin-access";
import { recordAllowanceChange } from "./allowance-changes";
import { recarryMemberLeaveType } from "./rollover";

export interface AllowanceOverrideInput extends AllowanceEdit {
  userId: string;
  leaveTypeId: string;
  year: number;
}

export interface AllowanceOverrideResult {
  row: AllowanceRow;
  /**
   * False when the amounts already matched: nothing was written or recorded, and the
   * reason was dropped. The caller must say so rather than report a save.
   */
  changed: boolean;
}

/**
 * Sets a person's allowance for one leave type and year (last year, this year or a
 * later one).
 *
 * Takes the person's member lock (`lockMember`, `FOR NO KEY UPDATE`) before reading or
 * writing the row, like submit and the year rollover: every writer of a person's balance
 * inputs takes it, so a submit in flight either sees the new allowance or finishes first.
 * Writes `audit_log` (`allowance.edited`, the reason in its `after`) and a
 * `balance.adjusted` event (`reason: "admin_edit"`) in the same transaction. An edit
 * to last year then recomputes the carry into this year, as the rollover would
 * (`allowance.carried_over` / `allowance.created`, actor `null`).
 *
 * @throws DomainError `forbidden`, `invalid_input` (amounts, reason, or a year before
 *   last), `not_found` (a person or leave type outside the actor's company),
 *   `no_company`, or `policy_unavailable` (editing last year under an unknown policy).
 */
export async function setAllowanceOverride(ctx: ServiceContext, actor: Actor, input: AllowanceOverrideInput): Promise<AllowanceOverrideResult> {
  assertCanAdminister(actor);
  const edit = normalizeAllowanceEdit(input);
  if (!isUuid(input.leaveTypeId)) throw new DomainError("not_found");

  return ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    const company = await findCompany(tx, actor.companyId);
    if (!company) throw new DomainError("no_company");
    const currentYear = yearInTimeZone(company.timezone, ctx.now());
    assertAllowanceYear(input.year, currentYear);
    const member = await lockMember(tx, actor.companyId, input.userId);
    if (!member) throw new DomainError("not_found");
    const leaveType = await findLeaveTypeForAdmin(tx, actor.companyId, input.leaveTypeId);
    if (!leaveType) throw new DomainError("not_found");

    const where = { userId: member.id, leaveTypeId: leaveType.id, year: input.year };
    const before = await findAllowance(tx, where);
    if (before && before.days === edit.days && before.adjustmentDays === edit.adjustmentDays) return { row: before, changed: false };
    const after = await writeAllowanceOverride(tx, { ...where, days: edit.days, adjustmentDays: edit.adjustmentDays });
    await recordAllowanceChange(tx, {
      companyId: actor.companyId,
      reason: "admin_edit",
      before: before ?? null,
      after,
      actorId: actor.id,
      note: edit.reason,
    });
    if (input.year < currentYear && member.isActive) {
      await recarryMemberLeaveType(tx, {
        companyId: actor.companyId,
        timezone: company.timezone,
        policy: resolveAllowancePolicy(company.allowancePolicy),
        member,
        leaveType,
        closingYear: input.year,
      });
    }
    return { row: after, changed: true };
  });
}
