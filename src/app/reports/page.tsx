import type { Metadata } from "next";
import Link from "next/link";
import { MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/domain/calendar";
import type { LeaveReport } from "@/domain/reports";
import { formatCount, formatDays, formatMonth, formatWait } from "@/lib/format";
import { getLeaveReport } from "@/server/services/reports";
import { departmentParamSchema, readParam, yearParamSchema } from "@/app/_lib/calendar-input";
import { orNotFound, requireMemberPage } from "@/app/_lib/page-context";
import { BarList } from "@/components/charts/bar-list";
import { type MonthColumn, MonthColumns } from "@/components/charts/month-columns";
import { StatTile } from "@/components/charts/stat-tile";
import { YearColumns } from "@/components/charts/year-columns";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { PillNav } from "@/components/navigation/pill-nav";
import { YearNav } from "@/components/navigation/year-nav";
import { ColorDot } from "@/components/ui/color-label";
import { Section } from "@/components/ui/section";
import { buttonClass, cx, surface, tableCell, tableHeadCell, textLink } from "@/components/ui/styles";

export const metadata: Metadata = { title: "Reports · OOOhm" };

function reportHref(path: string, year: number, departmentId: string | null): string {
  const query = new URLSearchParams({ year: String(year) });
  if (departmentId) query.set("department", departmentId);
  return `${path}?${query}`;
}

const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
function changeOnLastYear(report: LeaveReport): string | undefined {
  const [before, now] = report.trend.slice(-2);
  if (!before || before.days === 0) return undefined;
  const change = Math.round(((now.days - before.days) / before.days) * 100);
  if (change === 0) return `The same as ${before.year}`;
  return `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}% on ${before.year}`;
}

/**
 * Reports: how much time off the company (admins) or a manager's team took in a year,
 * by month against the year before, over the last five years, by leave type, department
 * and person, with a CSV of the people table. Employees get a 404, as the service does.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="reports" />;
  const params = await searchParams;
  const year = readParam(yearParamSchema, params.year);
  const { nav, departments, department, scope, report } = await orNotFound(
    getLeaveReport(page.ctx, page.actor, {
      year: year === undefined ? undefined : Number(year),
      departmentId: readParam(departmentParamSchema, params.department),
    }),
  );
  const departmentId = department?.id ?? null;
  const { totals } = report;
  const who = scope.kind === "company" ? "everyone in the company" : "the people who report to you";
  const typesInMonths = report.leaveTypes.filter((t) => report.months.some((m) => m.byType.some((s) => s.leaveTypeId === t.id)));
  const anyAhead = report.months.some((m) => m.ahead && m.total > 0);
  const change = changeOnLastYear(report);

  return (
    <AppPage
      nav={page.nav}
      current="reports"
      title="Reports"
      description={`Time off for ${who}: when it was taken, of which kind, and how it compares with earlier years.`}
      action={
        <a href={reportHref("/reports/export", nav.year, departmentId)} className={buttonClass("outline", "sm")} download>
          Download CSV
        </a>
      }
      className="space-y-8"
    >
      <div className="space-y-4">
        <YearNav year={nav.year} min={MIN_CALENDAR_YEAR} max={Math.min(MAX_CALENDAR_YEAR, nav.current + 1)} href={(y) => reportHref("/reports", y, departmentId)} />
        {departments.length > 0 && (
          <PillNav
            label="Departments"
            items={[{ id: null, name: "Everyone" }, ...departments].map((d) => ({
              href: reportHref("/reports", nav.year, d.id),
              label: d.name,
              current: d.id === departmentId ? "page" : undefined,
            }))}
          />
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Days off" value={totals.approvedDays} detail={change ?? `${formatCount(totals.peopleOff, "person", "people")} took time off`} />
        <StatTile label="Per person" value={totals.daysPerPerson} detail={`Across ${formatCount(totals.headcount, "person", "people")}`} />
        <StatTile label="Days waiting" value={totals.pendingDays} detail={formatCount(totals.requests.pending, "request", "requests")} />
        <StatTile
          label="Decision time"
          value={totals.medianDecisionHours === null ? "–" : formatWait(totals.medianDecisionHours)}
          detail={totals.medianDecisionHours === null ? "No decisions yet" : `Median of ${formatCount(totals.decisions, "decision", "decisions")}`}
        />
      </dl>

      <Section title="By month" surface>
        {totals.approvedDays === 0 && report.previousYearMonths.every((d) => d === 0) ? (
          <p className="text-muted">No approved time off in {nav.year} or {nav.year - 1}.</p>
        ) : (
          <>
            <MonthColumns columns={monthColumns(report)} compareLabel={String(nav.year - 1)} />
            <ul aria-label="Key" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {typesInMonths.map((t) => (
                <li key={t.id} className="flex items-center gap-1.5">
                  <ColorDot color={t.color} />
                  {t.name}
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 rounded-full bg-foreground/45" />
                {nav.year - 1}
              </li>
              {anyAhead && <li>Lighter months are booked ahead</li>}
            </ul>
            <details className="text-sm">
              <summary className={cx(textLink, "w-fit cursor-pointer text-muted")}>Show as a table</summary>
              <MonthTable report={report} />
            </details>
          </>
        )}
      </Section>

      <Section title="Year over year" surface>
        <YearColumns years={report.trend} />
        <p className="sr-only">{report.trend.map((y) => `${y.year}: ${formatDays(y.days)}`).join(", ")}</p>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="By leave type" surface>
          {report.byType.length === 0 ? (
            <p className="text-muted">Nothing yet.</p>
          ) : (
            <BarList
              label="Days off by leave type"
              items={report.byType.map((t) => ({
                key: t.leaveTypeId,
                label: t.name,
                value: t.days,
                valueLabel: formatDays(t.days),
                detail: formatCount(t.requests, "request", "requests"),
                color: t.color,
              }))}
            />
          )}
        </Section>
        <Section title="Requests" surface>
          <RequestCounts report={report} />
        </Section>
      </div>

      {!department && report.byDepartment.length > 1 && (
        <Section title="By department" surface>
          <BarList
            label="Days off per person by department"
            items={report.byDepartment.map((d) => ({
              key: d.departmentId ?? "none",
              label: d.name,
              value: d.daysPerPerson,
              valueLabel: `${d.daysPerPerson} per person`,
              detail: `${formatDays(d.days)}, ${formatCount(d.headcount, "person", "people")}`,
            }))}
          />
        </Section>
      )}

      <Section title="People">
        <PeopleTable report={report} />
      </Section>
    </AppPage>
  );
}

function RequestCounts({ report }: { report: LeaveReport }) {
  const { requests } = report.totals;
  const rows: [string, number][] = [
    ["Approved", requests.approved],
    ["Waiting", requests.pending],
    ["Declined", requests.rejected],
    ["Cancelled", requests.cancelled],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {rows.map(([label, n]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="text-muted">{label}</dt>
          <dd className="tabular-nums">{n}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The month chart's numbers: each leave type's days, the month's total and the year before's. */
function MonthTable({ report }: { report: LeaveReport }) {
  const types = report.leaveTypes.filter((t) => report.months.some((m) => m.byType.some((s) => s.leaveTypeId === t.id)));
  const right = cx(tableHeadCell, "text-right");
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Approved days off by month and leave type</caption>
        <thead>
          <tr>
            <th scope="col" className={tableHeadCell}>
              Month
            </th>
            {types.map((t) => (
              <th key={t.id} scope="col" className={right}>
                {t.name}
              </th>
            ))}
            <th scope="col" className={right}>
              {report.year}
            </th>
            <th scope="col" className={right}>
              {report.year - 1}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.months.map((m, i) => (
            <tr key={m.month}>
              <th scope="row" className={cx(tableCell, "text-left font-normal")}>
                {formatMonth(m.month)}
                {m.ahead && m.total > 0 && <span className="text-muted"> (booked)</span>}
              </th>
              {types.map((t) => (
                <td key={t.id} className={cx(tableCell, "text-right tabular-nums")}>
                  {m.byType.find((s) => s.leaveTypeId === t.id)?.days ?? 0}
                </td>
              ))}
              <td className={cx(tableCell, "text-right font-medium tabular-nums")}>{m.total}</td>
              <td className={cx(tableCell, "text-right tabular-nums text-muted")}>{report.previousYearMonths[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PeopleTable({ report }: { report: LeaveReport }) {
  if (report.people.length === 0) return <p className="text-muted">Nobody to report on yet.</p>;
  return (
    <div className={cx(surface, "overflow-x-auto")}>
      <table className="w-full text-sm">
        <caption className="sr-only">Days off per person in {report.year}</caption>
        <thead>
          <tr>
            <th scope="col" className={tableHeadCell}>
              Person
            </th>
            <th scope="col" className={cx(tableHeadCell, "hidden sm:table-cell")}>
              Department
            </th>
            <th scope="col" className={cx(tableHeadCell, "text-right")}>
              Days off
            </th>
            <th scope="col" className={cx(tableHeadCell, "text-right")}>
              Waiting
            </th>
            {report.showsBalances && (
              <th scope="col" className={cx(tableHeadCell, "text-right")}>
                Days left
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {report.people.map((p) => (
            <tr key={p.userId}>
              <th scope="row" className={cx(tableCell, "text-left font-normal")}>
                {p.isActive ? (
                  <Link href={`/team/${p.userId}`} className={textLink}>
                    {p.name}
                  </Link>
                ) : (
                  <>
                    {p.name} <span className="text-muted">(inactive)</span>
                  </>
                )}
              </th>
              <td className={cx(tableCell, "hidden text-muted sm:table-cell")}>{p.departmentName ?? "–"}</td>
              <td className={cx(tableCell, "text-right tabular-nums")}>{p.approvedDays}</td>
              <td className={cx(tableCell, "text-right tabular-nums")}>{p.pendingDays}</td>
              {report.showsBalances && <td className={cx(tableCell, "text-right tabular-nums")}>{p.remaining ?? "–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
