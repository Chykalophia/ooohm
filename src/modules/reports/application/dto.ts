import "server-only";
import type { LeaveReport, ReportScope } from "../domain/leave-report";

/** Where a report sits and where its year links go. */
export interface ReportNav {
  year: number;
  /** The year holding today, in the company's time zone. */
  current: number;
}

/** A department as the report's filter shows it. */
export interface ReportDepartmentDTO {
  id: string;
  name: string;
}

/** What the Reports page and its export read: the report and where it sits. */
export interface LeaveReportDTO {
  nav: ReportNav;
  /** Every department of the company, for the filter, by name. */
  departments: ReportDepartmentDTO[];
  /** The department the report is narrowed to, if any. */
  department: ReportDepartmentDTO | null;
  scope: ReportScope;
  report: LeaveReport;
}

/** What {@link toLeaveReportDTO} maps from: the query's loaded pieces, departments as stored. */
export interface LeaveReportView {
  nav: ReportNav;
  departments: readonly { id: string; name: string }[];
  department: { id: string; name: string } | null;
  scope: ReportScope;
  report: LeaveReport;
}

const toDepartment = ({ id, name }: { id: string; name: string }): ReportDepartmentDTO => ({ id, name });

/** The report as the page shows it: departments trimmed to their id and name. */
export function toLeaveReportDTO(view: LeaveReportView): LeaveReportDTO {
  return {
    nav: { year: view.nav.year, current: view.nav.current },
    departments: view.departments.map(toDepartment),
    department: view.department ? toDepartment(view.department) : null,
    scope: view.scope,
    report: view.report,
  };
}
