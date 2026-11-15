import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { assertValidRange, type LeaveRange, rangesOverlap } from "@/shared/kernel/leave-range";
import { assertCovered } from "../../domain/allowance-policy";
import { resolveAllowancePolicy } from "../../domain/policy-registry";
import type { LeaveAssessment, LeaveDraft } from "../dto";
import type { BalancesStore } from "../ports";
import { loadBalanceInputs } from "./load-balances";

export function draftRange(draft: LeaveDraft): LeaveRange {
  return { startDate: draft.startDate, endDate: draft.endDate || draft.startDate, dayPortion: draft.dayPortion };
}

/**
 * The single computation behind both the live preview and submitting a request, so
 * what the person is shown is exactly what submit will decide.
 *
 * In order: validates the range; requires an active leave type of the actor's
 * company; resolves the company's allowance policy; counts working days per year
 * (company working days, minus holidays); refuses a request worth nothing, one that
 * overlaps the actor's pending or approved time, and one a tracked balance cannot
 * cover in any year (pending requests, and days already carried into the next year,
 * count as spent).
 *
 * Read-only. Submit calls it inside its transaction after locking the requester, so
 * concurrent submits by one person see each other's days. `actor` is whoever the time
 * off is for: the person themself, or the one a manager or admin adds it for.
 *
 * @throws DomainError `invalid_input`, `invalid_date_range`, `range_too_long`,
 *   `half_day_multi_day`, `leave_type_unavailable`, `no_company`,
 *   `policy_unavailable`, `zero_days`, `overlapping_request` or
 *   `insufficient_balance` (with `BalanceShortfallDetails`).
 */
export async function assessLeaveRequest(store: BalancesStore, actor: Pick<Actor, "id" | "companyId">, draft: LeaveDraft): Promise<LeaveAssessment> {
  const range = draftRange(draft);
  assertValidRange(range);
  if (!isUuid(draft.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  // Independent reads, fetched together; the checks below keep their order.
  const { directory } = store;
  const [leaveType, company, holidays, existing] = await Promise.all([
    directory.activeLeaveType(actor.companyId, draft.leaveTypeId),
    directory.company(actor.companyId),
    directory.holidayDates(actor.companyId, range.startDate, range.endDate),
    directory.activeRequestsInRange(actor.id, range.startDate, range.endDate),
  ]);
  if (!leaveType) throw new DomainError("leave_type_unavailable");
  if (!company) throw new DomainError("no_company");
  const policy = resolveAllowancePolicy(company.allowancePolicy);

  const split = policy.periodsFor(range, { workingDays: company.workingDays, holidays });
  if (split.length === 0) {
    // Only on this path: name the holidays, so the person learns they needn't ask.
    throw new DomainError("zero_days", undefined, { holidays: await directory.holidays(actor.companyId, range.startDate, range.endDate) });
  }
  if (existing.some((other) => rangesOverlap(range, other))) throw new DomainError("overlapping_request");

  const inputs = await loadBalanceInputs(store, actor.companyId, { userIds: [actor.id], years: split.map((s) => s.year), leaveTypeIds: [leaveType.id] });
  const charges = split.map(({ year, days }) => ({ year, days, before: inputs.balance(policy, leaveType, actor.id, year) }));
  assertCovered(charges);

  return {
    range,
    leaveType: { id: leaveType.id, name: leaveType.name },
    days: split.reduce((sum, s) => sum + s.days, 0),
    charges,
  };
}
