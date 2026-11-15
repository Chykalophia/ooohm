import type { BarListItem } from "@/components/charts/bar-list";
import type { MonthColumn } from "@/components/charts/month-columns";
import type { PillNavItem } from "@/components/navigation/pill-nav";
import { MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/shared/kernel/calendar";
import { formatCount, formatDays, formatMonth, formatWait } from "@/lib/format";
import type { LeaveReportDTO } from "../application/dto";
import type { LeaveReport, ReportLeaveType } from "../domain/leave-report";

/** The page's or the export's address for a year and an optional department. */
export function reportHref(path: string, year: number, departmentId: string | null): string {
  const query = new URLSearchParams({ year: String(year) });
  if (departmentId) query.set("department", departmentId);
  return `${path}?${query}`;
}

export const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthColumns(report: LeaveReport): MonthColumn[] {
  const types = new Map(report.leaveTypes.map((t) => [t.id, t]));
  return report.months.map((m, i) => ({
    label: SHORT_MONTH[i],
    title: formatMonth(m.month),
    segments: m.byType.map((s) => ({ key: s.leaveTypeId, name: types.get(s.leaveTypeId)?.name ?? "Leave", color: types.get(s.leaveTypeId)?.color ?? "#888888", days: s.days })),
    total: m.total,
    compare: report.previousYearMonths[i] ?? 0,
    ahead: m.ahead,
  }));
}

/** "Up 12% on 2025", "Down 3% on 2025", "The same as 2025", or nothing without last year's days. */
export function changeOnLastYear(report: LeaveReport): string | undefined {
  const [before, now] = report.trend.slice(-2);
  if (!before || before.days === 0) return undefined;
  const change = Math.round(((now.days - before.days) / before.days) * 100);
  if (change === 0) return `The same as ${before.year}`;
  return `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}% on ${before.year}`;
}

/** Leave types that appear in any month, in the report's order: the month chart's key and table columns. */
export function typesInMonths(report: LeaveReport): readonly ReportLeaveType[] {
  return report.leaveTypes.filter((t) => report.months.some((m) => m.byType.some((s) => s.leaveTypeId === t.id)));
}

/** Who a report covers, as the page's description says it. */
function whoLabel({ department, scope }: LeaveReportDTO): string {
  if (department) return `${scope.kind === "company" ? "everyone" : "the people who report to you"} in ${department.name}`;
  return scope.kind === "company" ? "everyone in the company" : "the people who report to you";
}

/** The year links and department pills: each keeps the other's choice. */
function navigation({ nav, departments, department }: LeaveReportDTO) {
  const departmentId = department?.id ?? null;
  return {
    exportHref: reportHref("/reports/export", nav.year, departmentId),
    yearNav: { year: nav.year, min: MIN_CALENDAR_YEAR, max: Math.min(MAX_CALENDAR_YEAR, nav.current + 1), href: (y: number) => reportHref("/reports", y, departmentId) },
    departmentNav:
      departments.length === 0
        ? null
        : [{ id: null, name: "Everyone" }, ...departments].map(
            (d): PillNavItem => ({ href: reportHref("/reports", nav.year, d.id), label: d.name, current: d.id === departmentId ? "page" : undefined }),
          ),
  };
}

/** The four tiles above the charts. */
function statTiles(report: LeaveReport) {
  const { totals } = report;
  return [
    { label: "Days off", value: totals.approvedDays, detail: changeOnLastYear(report) ?? `${formatCount(totals.peopleOff, "person", "people")} took time off` },
    { label: "Per person", value: totals.daysPerPerson, detail: `Across ${formatCount(totals.headcount, "person", "people")}` },
    { label: "Days waiting", value: totals.pendingDays, detail: formatCount(totals.requests.pending, "request", "requests") },
    {
      label: "Decision time",
      value: totals.medianDecisionHours === null ? "–" : formatWait(totals.medianDecisionHours),
      detail: totals.medianDecisionHours === null ? "No decisions yet" : `Median of ${formatCount(totals.decisions, "decision", "decisions")}`,
    },
  ];
}

/** The by-month chart and the running total, against the year before. */
function months(report: LeaveReport, year: number) {
  const { totals } = report;
  return {
    hasMonths: !(totals.approvedDays === 0 && report.previousYearMonths.every((d) => d === 0)),
    monthColumns: monthColumns(report),
    monthKey: typesInMonths(report),
    anyAhead: report.months.some((m) => m.ahead && m.total > 0),
    showsRunningTotal: totals.approvedDays > 0 || report.previousYearMonths.some((d) => d > 0),
    runningTotal: {
      labels: SHORT_MONTH,
      days: report.runningTotal.days,
      previous: report.runningTotal.previous,
      takenMonths: report.months.filter((m) => !m.ahead).length,
      label: String(year),
      compareLabel: String(year - 1),
    },
    monthsAhead: report.months.some((m) => m.ahead),
  };
}

/** The bar lists: by leave type, and by department when the report is not narrowed to one. */
function bars(report: LeaveReport, narrowed: boolean) {
  return {
    byType: report.byType.map(
      (t): BarListItem => ({
        key: t.leaveTypeId,
        label: t.name,
        value: t.days,
        valueLabel: formatDays(t.days),
        detail: formatCount(t.requests, "request", "requests"),
        color: t.color,
      }),
    ),
    byDepartment:
      !narrowed && report.byDepartment.length > 1
        ? report.byDepartment.map(
            (d): BarListItem => ({
              key: d.departmentId ?? "none",
              label: d.name,
              value: d.daysPerPerson,
              valueLabel: `${d.daysPerPerson} per person`,
              detail: `${formatDays(d.days)}, ${formatCount(d.headcount, "person", "people")}`,
            }),
          )
        : null,
  };
}

/** Everything the Reports page shows, worded and shaped for its components. */
export function presentLeaveReport(dto: LeaveReportDTO) {
  const { nav, report } = dto;
  return {
    year: nav.year,
    previousYear: nav.year - 1,
    description: `Time off for ${whoLabel(dto)}: when it was taken, of which kind, and how it compares with earlier years.`,
    ...navigation(dto),
    stats: statTiles(report),
    ...months(report, nav.year),
    trend: report.trend,
    trendText: report.trend.map((y) => `${y.year}: ${formatDays(y.days)}`).join(", "),
    ...bars(report, dto.department !== null),
  };
}

/** The Reports page's view model. */
export type LeaveReportPresentation = ReturnType<typeof presentLeaveReport>;
