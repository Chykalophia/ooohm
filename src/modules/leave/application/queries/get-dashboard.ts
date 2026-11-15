import "server-only";
import type { Actor } from "@/domain/actor";
import { addDays, type BalanceSummary, isEmptyBalance, type LeaveTypeWithAllowance, resolveAllowancePolicy } from "@/modules/balances";
import { readApprovalMode } from "@/domain/approval-rule";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import { DomainError, isDomainError } from "@/domain/errors";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import { nextWorkingDay, WORKING_DAY_LOOKAHEAD } from "@/shared/kernel/leave-days";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { canCancelOn } from "../../domain/leave-status";
import type { DashboardDTO, DashboardRequestDTO } from "../dto";
import type { CompanySettings, LeaveDeps, OwnRequest } from "../ports";

/** How many of a person's requests the dashboard shows; the rest are on "Your requests". */
export const DASHBOARD_REQUESTS = 5;

/** When Home starts saying which days won't carry into next year (month and day). */
const EXPIRY_NUDGE_FROM = "11-01";

/** How far back "usually decides within…" looks, and how many decisions it needs first. */
const TYPICAL_WAIT_DAYS = 180;
const TYPICAL_WAIT_MIN_DECISIONS = 3;

/**
 * Everything the dashboard renders for the actor, in one call, in six queries whatever
 * the number of types or requests (seven while one of its latest few requests waits on
 * someone): company settings, leave types and the actor's requests in parallel; then the
 * balances' allowance rows and booked-day sums, the look-ahead holidays and, for pending
 * requests, their approvers' usual decision times, in parallel. The form's leave types
 * and the balances share the one leave-type read.
 *
 * `balances` is `null` when the company's allowance policy is unknown. That is logged
 * as `allowance_policy_unavailable` and the rest of the dashboard still renders;
 * submitting and previewing refuse with `policy_unavailable` instead.
 *
 * Fails with `no_company` when the actor's company is missing.
 */
export async function getDashboard(deps: LeaveDeps, actor: Actor): Promise<ServiceResult<DashboardDTO>> {
  return attempt(async () => {
    const { directory, requests: repository } = deps.read;
    const [settings, types, requests] = await Promise.all([
      directory.companySettings(actor.companyId),
      directory.leaveTypesWithAllowance(actor.companyId),
      // One more than shown, to know whether "Your requests" holds more.
      repository.listOwn(actor.companyId, actor.id, DASHBOARD_REQUESTS + 1),
    ]);
    if (!settings) throw new DomainError("no_company");
    const now = deps.clock.now();
    const today = todayInTimeZone(settings.timezone, now);
    const shown = requests.slice(0, DASHBOARD_REQUESTS);
    const [balances, holidays, typicalWait] = await Promise.all([
      balancesOrNull(deps, actor, settings, types, yearInTimeZone(settings.timezone, now)),
      directory.holidayDates(actor.companyId, today, fromEpochDay(toEpochDay(today) + WORKING_DAY_LOOKAHEAD - 1)),
      typicalWaits(deps, actor, shown, now),
    ]);
    return {
      requests: shown.map((r) => dashboardRequest(r, today, typicalWait)),
      approvalMode: readApprovalMode(settings.approvalMode),
      moreRequests: requests.length > DASHBOARD_REQUESTS,
      defaultDate: nextWorkingDay(today, { workingDays: settings.workingDays, holidays }),
      leaveTypes: types.filter((t) => !t.archived).map(({ id, name, code, color }) => ({ id, name, code, color })),
      // Without types they have no days of at all, so "0 left of 0" never shows. Admin views keep them.
      balances: balances && { ...balances, items: balances.items.filter((i) => !isEmptyBalance(i.balance)) },
      expiring: expiringDays(settings, types, balances, today),
    };
  });
}

/** A request as the dashboard lists it: whether it can be cancelled today, and how long its approver usually takes. */
function dashboardRequest(r: OwnRequest, today: string, typicalWait: Map<string, number>): DashboardRequestDTO {
  return {
    ...r,
    cancellable: canCancelOn(r, today),
    typicalWaitHours: r.status === "pending" && r.approverId ? (typicalWait.get(r.approverId) ?? null) : null,
  };
}

/** The person's balances, or `null` (logged) when the company's allowance policy is unknown. */
async function balancesOrNull(deps: LeaveDeps, actor: Actor, settings: CompanySettings, types: readonly LeaveTypeWithAllowance[], year: number) {
  return deps.read.allowances.summarize(actor, { allowancePolicy: settings.allowancePolicy, types, year }).catch((err: unknown) => {
    if (!isDomainError(err, "policy_unavailable")) throw err;
    log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
    return null;
  });
}

/** Who has each of the shown pending requests (other than the actor), and how long they usually take to decide. */
async function typicalWaits(deps: LeaveDeps, actor: Actor, shown: readonly OwnRequest[], now: Date): Promise<Map<string, number>> {
  const waitingOn = [...new Set(shown.filter((r) => r.status === "pending" && r.approverId && r.approverId !== actor.id).map((r) => r.approverId as string))];
  const waits = await deps.read.requests.medianDecisionHours({
    companyId: actor.companyId,
    approverIds: waitingOn,
    since: new Date(now.getTime() - TYPICAL_WAIT_DAYS * 86_400_000),
    minSamples: TYPICAL_WAIT_MIN_DECISIONS,
  });
  return new Map(waits.map((w) => [w.approverId, w.hours]));
}

/**
 * From November 1 (company time zone): days of the main leave type (the first active
 * one, the form's default, usually vacation) that will not carry into next year, so
 * Home can say so once. Only that type: nobody should be told to use up sick days.
 * Empty before November, and when nothing is left to lose.
 */
function expiringDays(settings: CompanySettings, types: readonly LeaveTypeWithAllowance[], balances: BalanceSummary | null, today: string) {
  if (!balances || today < `${balances.year}-${EXPIRY_NUDGE_FROM}`) return [];
  return balances.items.flatMap((item) => {
    const type = types.find((t) => t.id === item.leaveTypeId);
    const main = types.find((t) => !t.archived);
    if (!type || type.id !== main?.id || !item.balance.tracked || item.balance.remaining <= 0) return [];
    const carried = resolveAllowancePolicy(settings.allowancePolicy).carryover(type, item.balance) ?? 0;
    const days = addDays(item.balance.remaining, -Math.min(carried, item.balance.remaining));
    return days > 0 ? [{ leaveTypeId: item.leaveTypeId, name: item.name, days }] : [];
  });
}
