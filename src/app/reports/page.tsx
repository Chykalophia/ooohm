import type { Metadata } from "next";
import { getLeaveReport, presentLeaveReport, readReportQuery } from "@/modules/reports";
import { unwrap } from "@/shared/lib/result";
import { orNotFound, requireMemberPage } from "@/app/_lib/page-context";
import { BarList } from "@/components/charts/bar-list";
import { MonthColumns } from "@/components/charts/month-columns";
import { RunningTotalLines } from "@/components/charts/running-total-lines";
import { StatTile } from "@/components/charts/stat-tile";
import { YearColumns } from "@/components/charts/year-columns";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { PillNav } from "@/components/navigation/pill-nav";
import { YearNav } from "@/components/navigation/year-nav";
import { ColorDot } from "@/components/ui/color-label";
import { Section } from "@/components/ui/section";
import { buttonClass, cx, textLink } from "@/components/ui/styles";
import { MonthTable, PeopleTable, RequestCounts, RunningTotalTable } from "./report-tables";

export const metadata: Metadata = { title: "Reports · OOOhm" };

const keyClass = "flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted";
const tableToggle = cx(textLink, "w-fit cursor-pointer text-muted");

/**
 * Reports: how much time off the company (admins) or a manager's team took in a year,
 * by month against the year before, over the last five years, by leave type, department
 * and person, with a CSV of the people table. Employees get a 404, as the query does.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="reports" />;
  const dto = await orNotFound(getLeaveReport(page.ctx, page.actor, readReportQuery(await searchParams)).then(unwrap));
  const { report } = dto;
  const view = presentLeaveReport(dto);

  return (
    <AppPage
      nav={page.nav}
      current="reports"
      title="Reports"
      description={view.description}
      action={
        <a href={view.exportHref} className={buttonClass("outline", "sm")} download>
          Download CSV
        </a>
      }
      className="space-y-8"
    >
      <div className="space-y-4">
        <YearNav {...view.yearNav} />
        {view.departmentNav && <PillNav label="Departments" items={view.departmentNav} />}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {view.stats.map((s) => (
          <StatTile key={s.label} {...s} />
        ))}
      </dl>

      <Section title="By month" surface>
        {!view.hasMonths ? (
          <p className="text-muted">
            No approved time off in {view.year} or {view.previousYear}.
          </p>
        ) : (
          <>
            <MonthColumns columns={view.monthColumns} compareLabel={String(view.previousYear)} />
            <ul aria-label="Key" className={keyClass}>
              {view.monthKey.map((t) => (
                <li key={t.id} className="flex items-center gap-1.5">
                  <ColorDot color={t.color} />
                  {t.name}
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 rounded-full bg-foreground/45" />
                {view.previousYear}
              </li>
              {view.anyAhead && <li>Lighter months are booked ahead</li>}
            </ul>
            <details className="text-sm">
              <summary className={tableToggle}>Show as a table</summary>
              <MonthTable report={report} />
            </details>
          </>
        )}
      </Section>

      {view.showsRunningTotal && (
        <Section title="Running total" surface>
          <RunningTotalLines {...view.runningTotal} />
          <ul aria-label="Key" className={keyClass}>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-accent" />
              {view.year}
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-muted" />
              {view.previousYear}
            </li>
            {view.monthsAhead && <li>Dashed months are still ahead</li>}
          </ul>
          <details className="text-sm">
            <summary className={tableToggle}>Show as a table</summary>
            <RunningTotalTable report={report} />
          </details>
        </Section>
      )}

      <Section title="Year over year" surface>
        <YearColumns years={view.trend} />
        <p className="sr-only">{view.trendText}</p>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="By leave type" surface>
          {view.byType.length === 0 ? <p className="text-muted">Nothing yet.</p> : <BarList label="Days off by leave type" items={view.byType} />}
        </Section>
        <Section title="Requests" surface>
          <RequestCounts report={report} />
        </Section>
      </div>

      {view.byDepartment && (
        <Section title="By department" surface>
          <BarList label="Days off per person by department" items={view.byDepartment} />
        </Section>
      )}

      <Section title="People">
        <PeopleTable report={report} />
      </Section>
    </AppPage>
  );
}
