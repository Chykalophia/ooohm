import "server-only";
import type { Actor } from "@/domain/actor";
import { addDays } from "@/domain/allowance-policy";
import { MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/domain/calendar";
import { DomainError } from "@/domain/errors";
import type { YearDays } from "@/domain/leave-days";
import { teamLabel } from "@/domain/person";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listHolidayDates } from "@/server/repositories/calendar";
import { findCompany } from "@/server/repositories/companies";
import { listDepartments } from "@/server/repositories/departments";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { loadBalances } from "@/server/services/balances";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import {
  buildLeaveReport,
  canSeeReportBalances,
  canViewReports,
  type LeaveReport,
  REPORT_TREND_YEARS,
  type ReportRequest,
  reportScopeFor,
} from "../../domain/leave-report";
import { listReportPeople, listReportRequestDays } from "../../infrastructure/drizzle-reports.repository";
import { type LeaveReportDTO, type ReportNav, toLeaveReportDTO } from "../dto";
import type { LeaveReportQuery } from "../schemas";

type RequestDayRow = Awaited<ReturnType<typeof listReportRequestDays>>[number];

/** One row per request and year, folded into one request with its split. */
function toReportRequests(rows: readonly RequestDayRow[]): ReportRequest[] {
  const byId = new Map<string, ReportRequest & { split: YearDays[] }>();
  for (const { year, days, ...r } of rows) {
    const seen = byId.get(r.id);
    if (seen) seen.split.push({ year, days });
    else byId.set(r.id, { ...r, split: [{ year, days }] });
  }
  return [...byId.values()];
}

type BalanceOf = NonNullable<Awaited<ReturnType<typeof loadBalances>>>;

/** Each person's days left in `year`, summed over the leave types they are tracked on; `null` with none tracked. */
function daysLeft(people: readonly { id: string }[], types: readonly { id: string; archived: boolean }[], balanceOf: BalanceOf, year: number) {
  return new Map(
    people.map((p) => {
      const tracked = types.flatMap((t) => {
        const b = balanceOf(p.id, t.id, year);
        // As on Home, a retired type counts only for someone who still has days of it.
        if (t.archived && b.used + b.pending === 0) return [];
        return b.tracked ? [b.remaining] : [];
      });
      return [p.id, tracked.length > 0 ? addDays(...tracked) : null] as const;
    }),
  );
}

/**
 * The leave report for admins (the whole company) and managers (their direct reports):
 * days taken and pending in a year, by month, leave type, department and person, the
 * year before by month and {@link REPORT_TREND_YEARS} years of totals, plus days left
 * when the actor may see balances ({@link canSeeReportBalances}). Days are what each
 * request's stored split charges (what balances count). Notes never leave the queries.
 *
 * Eight queries whatever the amount of leave: company, departments, leave types and
 * the people in scope in parallel; then their leave over the trend's years, two years
 * of holidays and, with balances, the allowance rows and booked-day sums, in parallel.
 * Six without balances.
 *
 * Fails with `not_found` for anyone but admins and managers, and with `no_company`.
 */
export async function getLeaveReport(ctx: ServiceContext, actor: Actor, query: LeaveReportQuery = {}): Promise<ServiceResult<LeaveReportDTO>> {
  return attempt(async () => toLeaveReportDTO(await loadLeaveReport(ctx, actor, query)));
}

/** @throws DomainError where {@link getLeaveReport} fails. */
async function loadLeaveReport(ctx: ServiceContext, actor: Actor, query: LeaveReportQuery) {
  if (!canViewReports(actor)) throw new DomainError("not_found");
  const scope = reportScopeFor(actor);
  const managerId = scope.kind === "team" ? scope.managerId : null;
  const [company, departments, types, everyone] = await Promise.all([
    findCompany(ctx.db, actor.companyId),
    listDepartments(ctx.db, actor.companyId),
    listLeaveTypesWithAllowance(ctx.db, actor.companyId),
    listReportPeople(ctx.db, actor.companyId, { managerId, departmentId: null }),
  ]);
  if (!company) throw new DomainError("no_company");

  const today = todayInTimeZone(company.timezone, ctx.now());
  const current = Number(today.slice(0, 4));
  const { year: asked } = query;
  const year = asked !== undefined && Number.isInteger(asked) && asked >= MIN_CALENDAR_YEAR && asked <= MAX_CALENDAR_YEAR ? asked : current;
  // Only a department of this company narrows the report; anything else means everyone.
  const department = departments.find((d) => d.id === query.departmentId) ?? null;
  const people = department ? everyone.filter((p) => p.departmentId === department.id) : everyone;
  const userIds = people.map((p) => p.id);
  const years = Array.from({ length: REPORT_TREND_YEARS }, (_, i) => year - REPORT_TREND_YEARS + 1 + i);
  const showsBalances = canSeeReportBalances(actor, company.managersSeeDetails);

  const [rows, holidays, balanceOf] = await Promise.all([
    listReportRequestDays(ctx.db, actor.companyId, userIds, years),
    listHolidayDates(ctx.db, actor.companyId, `${year - 1}-01-01`, `${year}-12-31`),
    showsBalances ? loadBalances(ctx.db, { companyId: actor.companyId, allowancePolicy: company.allowancePolicy, leaveTypes: types, userIds, years: [year] }) : null,
  ]);
  const requests = toReportRequests(rows);
  const remaining = balanceOf ? daysLeft(people, types, balanceOf, year) : null;

  // Archived types only where someone still has leave of them in the trend's years.
  const used = new Set(requests.map((r) => r.leaveTypeId));
  const leaveTypes = types.filter((t) => !t.archived || used.has(t.id)).map(({ id, name, color }) => ({ id, name, color }));

  const report: LeaveReport = buildLeaveReport({
    year,
    today,
    workingDays: company.workingDays,
    holidays,
    leaveTypes,
    departments: department ? [department] : departments,
    people: people.map((p) => ({ id: p.id, name: teamLabel(p), departmentId: p.departmentId, isActive: p.isActive })),
    requests,
    remaining,
  });
  const nav: ReportNav = { year, current };
  return { nav, departments, department, scope, report };
}
