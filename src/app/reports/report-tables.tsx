import Link from "next/link";
import { cx, surface, tableCell, tableHeadCell, textLink } from "@/components/ui/styles";
import { formatMonth } from "@/lib/format";
import { type LeaveReport, typesInMonths } from "@/modules/reports";

/** The report's requests by status. */
export function RequestCounts({ report }: { report: LeaveReport }) {
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

/** The running total's numbers: days so far by each month's end, this year and the year before. */
export function RunningTotalTable({ report }: { report: LeaveReport }) {
  const right = cx(tableHeadCell, "text-right");
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Approved days off so far by the end of each month</caption>
        <thead>
          <tr>
            <th scope="col" className={tableHeadCell}>
              By the end of
            </th>
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
                {m.ahead && m.total > 0 && <span className="text-muted"> (with bookings)</span>}
              </th>
              <td className={cx(tableCell, "text-right font-medium tabular-nums")}>{report.runningTotal.days[i]}</td>
              <td className={cx(tableCell, "text-right tabular-nums text-muted")}>{report.runningTotal.previous[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The month chart's numbers: each leave type's days, the month's total and the year before's. */
export function MonthTable({ report }: { report: LeaveReport }) {
  const types = typesInMonths(report);
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

/** Days off per person, with days left when the report shows balances. */
export function PeopleTable({ report }: { report: LeaveReport }) {
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
